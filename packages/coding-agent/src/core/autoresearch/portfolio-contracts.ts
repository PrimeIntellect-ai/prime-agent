import { sha256Hex } from "../workflow/contracts.js";

/** The only active portfolio schema accepted by this module. */
export const AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION = 3 as const;

const MAX_ARRAY_ENTRIES = 256;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_TEXT_BYTES = 16_384;
const MAX_PATH_BYTES = 1_024;
const MAX_DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RELATIVE_PATH = /^(?!\/)(?![A-Za-z]:)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/u;
const ARRAY_SORT = Array.prototype.sort;
const PARSED_CONTRACTS = new WeakSet<object>();
const PARSED_CANDIDATES = new WeakSet<object>();
const PARSED_MEASUREMENTS = new WeakSet<object>();

export type AutoResearchPortfolioScope = "terminal" | "learning";
export type AutoResearchPortfolioGoalRelationKind = "complementary" | "competing" | "prerequisite" | "conflict";
export type AutoResearchPortfolioMetricDirection = "lower" | "higher";
export type AutoResearchPortfolioMeasurementKind = "baseline" | "candidate" | "holdout" | "replay" | "adversarial";
export type AutoResearchPortfolioDatasetSplit = "training" | "validation" | "holdout";
export type AutoResearchPortfolioDatasetCoverage =
	| "complete"
	| "provider_empty"
	| "partial_coverage"
	| "unknown"
	| "missing";
export type AutoResearchPortfolioDatasetGapClassification =
	| "none"
	| "provider_empty"
	| "partial_coverage"
	| "unknown"
	| "missing";
export type AutoResearchPortfolioDatasetValidation = "passed" | "failed" | "unknown";
export type AutoResearchPortfolioDatasetLifecycle = "in_progress" | "sealed" | "superseded" | "quarantined";
export type AutoResearchPortfolioModelAccessAuthority =
	| "training_workers_training_only"
	| "validation_evaluator_host_only"
	| "holdout_host_aggregate_only";

export interface AutoResearchPortfolioDatasetProvenance {
	readonly sourceSystem: string;
	readonly sourceDataset: string;
	readonly ingestDigest: string;
	readonly lineageDigest: string;
	readonly provenanceReceiptDigest: string;
}

export interface AutoResearchPortfolioRestoreVerification {
	readonly locked: true;
	readonly independentlyRestored: boolean;
	readonly independentlyRehashed: boolean;
	readonly verificationEvidenceDigest: string | null;
}

export interface AutoResearchPortfolioSplitClosureRoots {
	readonly training: string;
	readonly validation: string;
	readonly holdout: string;
}

export interface AutoResearchPortfolioSplitBoundaryPolicy {
	readonly locked: true;
	readonly trainingEndExclusive: string;
	readonly validationStartInclusive: string;
	readonly validationEndExclusive: string;
	readonly holdoutStartInclusive: string;
	readonly holdoutEndExclusive: string;
	/** Canonical digest of this policy excluding policyDigest itself. */
	readonly policyDigest: string;
}

/** Dataset hashes, provenance receipts, and closure roots are external host commitments. */
export interface AutoResearchPortfolioDatasetArtifactBinding {
	readonly split: AutoResearchPortfolioDatasetSplit;
	readonly objectUri: string;
	readonly generation: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly schemaVersion: string;
	readonly modality: string;
	readonly instrumentSet: readonly string[];
	readonly sourceTimeStart: string;
	readonly sourceTimeEnd: string;
	readonly validationResult: AutoResearchPortfolioDatasetValidation;
	readonly coverage: AutoResearchPortfolioDatasetCoverage;
	readonly gapClassification: AutoResearchPortfolioDatasetGapClassification;
	readonly lifecycle: AutoResearchPortfolioDatasetLifecycle;
	readonly restoreVerification: AutoResearchPortfolioRestoreVerification;
	readonly provenance: AutoResearchPortfolioDatasetProvenance;
	readonly closureRootDigest: string;
	readonly accessAuthority: AutoResearchPortfolioModelAccessAuthority;
}

export interface AutoResearchPortfolioDatasetSplitManifest {
	readonly locked: true;
	readonly split: AutoResearchPortfolioDatasetSplit;
	readonly closureRootDigest: string;
	readonly artifacts: readonly AutoResearchPortfolioDatasetArtifactBinding[];
}

export interface AutoResearchPortfolioModelAccess {
	readonly training: "training_workers_training_only";
	readonly validation: "validation_evaluator_host_only";
	readonly holdout: "holdout_host_aggregate_only";
	readonly holdoutRowsVisible: false;
	readonly holdoutPerCaseFeedback: false;
	readonly holdoutReturns: "aggregate_signed_evidence_only";
	readonly signedAggregateEvidence: true;
}

export interface AutoResearchPortfolioInputManifest {
	readonly locked: true;
	readonly evaluationEpoch: number;
	readonly manifestRevision: number;
	readonly closureRootDigest: string;
	/** Canonical digest of this manifest excluding manifestDigest itself. */
	readonly manifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
	readonly splitBoundaryPolicy: AutoResearchPortfolioSplitBoundaryPolicy;
	readonly training: AutoResearchPortfolioDatasetSplitManifest;
	readonly validation: AutoResearchPortfolioDatasetSplitManifest;
	readonly holdout: AutoResearchPortfolioDatasetSplitManifest;
	readonly modelAccess: AutoResearchPortfolioModelAccess;
}

export interface AutoResearchPortfolioMetric {
	readonly metricId: string;
	readonly name: string;
	readonly requirementId: string;
	readonly direction: AutoResearchPortfolioMetricDirection;
	readonly target: number;
	readonly unit: string;
	readonly locked: true;
	readonly evaluationEpoch: number;
	readonly metricRevision: number;
	readonly closureRootDigest: string;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioAcceptanceRequirement {
	readonly requirementId: string;
	readonly statement: string;
	readonly locked: true;
	/** Canonical digest of this requirement excluding requirementDigest itself. */
	readonly requirementDigest: string;
}

export interface AutoResearchPortfolioMetricValue {
	readonly metricId: string;
	readonly value: number;
}

export interface AutoResearchPortfolioBaselineManifest {
	readonly locked: true;
	readonly measurementId: string;
	readonly metricValues: readonly AutoResearchPortfolioMetricValue[];
	readonly evidenceDigest: string;
	readonly evaluationEpoch: number;
	readonly closureRootDigest: string;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioEvaluatorManifest {
	readonly locked: true;
	readonly evaluatorId: string;
	readonly sourceDigest: string;
	readonly inputDigest: string;
	readonly environmentDigest: string;
	/** Canonical digest of this evaluator manifest excluding evaluatorDigest itself. */
	readonly evaluatorDigest: string;
	readonly evaluationEpoch: number;
	readonly evaluatorRevision: number;
	readonly closureRootDigest: string;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioParserManifest {
	readonly locked: true;
	readonly parserId: string;
	readonly kind: "json_object" | "scalar_number";
	readonly metricKeys: readonly string[];
	/** Canonical digest of this parser manifest excluding parserDigest itself. */
	readonly parserDigest: string;
	readonly evaluationEpoch: number;
	readonly inputManifestRevision: number;
	readonly closureRootDigest: string;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioCommandManifest {
	readonly locked: true;
	readonly argv: readonly string[];
	readonly shell: false;
	readonly cwd: string;
	/** Canonical digest of this command manifest excluding commandDigest itself. */
	readonly commandDigest: string;
}

export interface AutoResearchPortfolioRepeatabilityManifest {
	readonly locked: true;
	readonly runs: number;
	readonly aggregation: "exact" | "mean" | "median";
	readonly seed: string;
	readonly maxVariance: number;
}

export interface AutoResearchPortfolioUncertaintyManifest {
	readonly locked: true;
	readonly method: "bootstrap" | "analytic" | "deterministic";
	readonly confidence: number;
	readonly maxWidth: number;
	readonly maxVariance: number;
}

export interface AutoResearchPortfolioOpaqueHoldoutManifest {
	readonly locked: true;
	readonly policy: "host_only";
	readonly candidateVisible: false;
	readonly handleDigest: string;
	readonly inputDigest: string;
	readonly resolverDigest: string;
	readonly evaluationEpoch: number;
	readonly closureRootDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioFalsificationManifest {
	readonly locked: true;
	readonly criteria: readonly string[];
	/** Canonical digest of this manifest excluding manifestDigest itself. */
	readonly manifestDigest: string;
}

export interface AutoResearchPortfolioAdversarialManifest {
	readonly locked: true;
	readonly checks: readonly string[];
	/** Canonical digest of this manifest excluding manifestDigest itself. */
	readonly manifestDigest: string;
}

export interface AutoResearchPortfolioGoal {
	readonly goalId: string;
	readonly domainId: string;
	readonly title: string;
	readonly description: string;
	readonly scope: AutoResearchPortfolioScope;
	readonly metrics: readonly AutoResearchPortfolioMetric[];
	readonly baseline: AutoResearchPortfolioBaselineManifest;
	readonly evaluator: AutoResearchPortfolioEvaluatorManifest;
	readonly parser: AutoResearchPortfolioParserManifest;
	readonly command: AutoResearchPortfolioCommandManifest;
	readonly repeatability: AutoResearchPortfolioRepeatabilityManifest;
	readonly uncertainty: AutoResearchPortfolioUncertaintyManifest;
	readonly opaqueHoldout: AutoResearchPortfolioOpaqueHoldoutManifest;
	readonly falsification: AutoResearchPortfolioFalsificationManifest;
	readonly adversarial: AutoResearchPortfolioAdversarialManifest;
}

export interface AutoResearchPortfolioGoalRelation {
	readonly fromGoalId: string;
	readonly toGoalId: string;
	readonly relation: AutoResearchPortfolioGoalRelationKind;
	readonly rationale: string;
}

export interface AutoResearchPortfolioLexicographicTier {
	readonly tier: number;
	readonly goalIds: readonly string[];
}

export interface AutoResearchPortfolioHardBoundary {
	readonly boundaryId: string;
	readonly statement: string;
	readonly scope: AutoResearchPortfolioScope;
	readonly locked: true;
}

export interface AutoResearchPortfolioInvariant {
	readonly invariantId: string;
	readonly statement: string;
	readonly scope: AutoResearchPortfolioScope;
	readonly locked: true;
	readonly checkDigest: string;
}

export interface AutoResearchPortfolioNonGoal {
	readonly nonGoalId: string;
	readonly statement: string;
	readonly scope: AutoResearchPortfolioScope;
}

export interface AutoResearchPortfolioBudgets {
	readonly maxCandidates: number;
	readonly maxMeasurements: number;
	readonly maxWallSeconds: number;
	readonly maxCostMicrounits: number;
	readonly maxParallelCandidates: number;
	readonly maxTokens: number;
}

export interface AutoResearchPortfolioSafety {
	readonly locked: true;
	readonly network: "disabled" | "authorized";
	readonly externalEffects: "none" | "host_gated";
	readonly requireOpaqueHoldout: true;
	readonly requireAdversarialReview: true;
	readonly maxUncertainty: number;
}

export interface AutoResearchPortfolioScopePartition {
	readonly partitionId: string;
	readonly scope: AutoResearchPortfolioScope;
	readonly paths: readonly string[];
	readonly dataDigests: readonly string[];
	readonly mutableBy: "candidate" | "host" | "immutable";
}

export interface AutoResearchPortfolioImpactClosure {
	readonly authority: "host_derived";
	readonly derivationVersion: number;
	readonly directGoalIds: readonly string[];
	readonly transitiveGoalIds: readonly string[];
	readonly affectedPartitionIds: readonly string[];
	readonly affectedInvariantIds: readonly string[];
	readonly sourceDigest: string;
	readonly closureDigest: string;
}

export interface AutoResearchPortfolioSolutionFamily {
	readonly familyId: string;
	readonly name: string;
	readonly mechanismClass: string;
}

export interface AutoResearchPortfolioAncestry {
	readonly parentCandidateIds: readonly string[];
	readonly baseDigest: string;
	readonly lineageDigest: string;
}

export interface AutoResearchPortfolioCausalMechanism {
	readonly hypothesis: string;
	readonly intervention: string;
	readonly expectedObservation: string;
	readonly falsificationCondition: string;
	readonly mechanismDigest: string;
}

export interface AutoResearchPortfolioChange {
	readonly kind: "mechanism";
	readonly changedPaths: readonly string[];
	readonly parameterChanges: readonly string[];
	readonly changeDigest: string;
}

export interface AutoResearchPortfolioCandidate {
	readonly candidateId: string;
	readonly goalIds: readonly string[];
	readonly solutionFamily: AutoResearchPortfolioSolutionFamily;
	readonly ancestry: AutoResearchPortfolioAncestry;
	readonly causalMechanism: AutoResearchPortfolioCausalMechanism;
	readonly change: AutoResearchPortfolioChange;
	readonly scope: AutoResearchPortfolioScope;
}

export interface AutoResearchPortfolioVectorMeasurement {
	readonly metricId: string;
	readonly value: number;
}

/** Evaluator, parser, command, workspace, and evidence digests are external bindings. */
export interface AutoResearchPortfolioMeasurement {
	readonly measurementId: string;
	readonly goalId: string;
	readonly candidateId: string | null;
	readonly scope: AutoResearchPortfolioScope;
	readonly kind: AutoResearchPortfolioMeasurementKind;
	readonly vector: readonly AutoResearchPortfolioVectorMeasurement[];
	readonly repeatIndex: number;
	readonly sampleCount: number;
	readonly evaluationEpoch: number;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
	readonly confidenceInterval: AutoResearchPortfolioConfidenceInterval;
	readonly variance: number;
	readonly runCount: number;
	readonly aggregation: "exact" | "mean" | "median";
	readonly inputDigest: string;
	readonly evaluatorDigest: string;
	readonly parserDigest: string;
	readonly commandDigest: string;
	readonly workspaceDigest: string;
	readonly evidenceDigests: readonly string[];
	readonly measuredAt: string;
	/** Canonical digest of this measurement excluding measurementDigest itself. */
	readonly measurementDigest: string;
}

export interface AutoResearchPortfolioMeasurementBindingContext {
	readonly confidenceLevel: number;
	readonly evaluationEpoch?: number;
	readonly inputManifestDigest?: string;
	readonly splitClosureRoots?: AutoResearchPortfolioSplitClosureRoots;
}

export interface AutoResearchPortfolioConfidenceInterval {
	readonly lower: number;
	readonly upper: number;
	readonly level: number;
}

export interface AutoResearchPortfolioContract {
	readonly schemaVersion: typeof AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION;
	readonly contractId: string;
	readonly objective: string;
	readonly acceptanceRequirements: readonly AutoResearchPortfolioAcceptanceRequirement[];
	readonly goals: readonly AutoResearchPortfolioGoal[];
	readonly goalRelations: readonly AutoResearchPortfolioGoalRelation[];
	readonly lexicographicTiers: readonly AutoResearchPortfolioLexicographicTier[];
	readonly hardBoundaries: readonly AutoResearchPortfolioHardBoundary[];
	readonly invariants: readonly AutoResearchPortfolioInvariant[];
	readonly nonGoals: readonly AutoResearchPortfolioNonGoal[];
	readonly budgets: AutoResearchPortfolioBudgets;
	readonly safety: AutoResearchPortfolioSafety;
	readonly inputManifest: AutoResearchPortfolioInputManifest;
	readonly scopePartitions: readonly AutoResearchPortfolioScopePartition[];
	readonly terminalScope: "terminal";
	readonly learningScope: "learning";
}

export interface AutoResearchPortfolioTrainingArtifactProjection {
	readonly objectUri: string;
	readonly generation: number;
	/** External content hash for this training artifact. */
	readonly sha256: string;
	readonly bytes: number;
	readonly schemaVersion: string;
	readonly modality: string;
	readonly instrumentSet: readonly string[];
}

export interface AutoResearchPortfolioTrainingProjection {
	readonly split: "training";
	/** Canonical digest of the complete locked input manifest. */
	readonly manifestDigest: string;
	/** External closure-root digest for the physical training split. */
	readonly closureRootDigest: string;
	readonly evaluationEpoch: number;
	readonly manifestRevision: number;
	readonly artifacts: readonly AutoResearchPortfolioTrainingArtifactProjection[];
}

/** A host-authenticated provenance record that is intentionally not an active portfolio. */
export interface AutoResearchPortfolioReadOnlyProvenance {
	readonly kind: "read_only_provenance";
	readonly source: string;
	readonly sourceDigest: string;
	readonly recordedAt: string;
}

function fail(label: string, detail: string): never {
	throw new Error(`AutoResearch portfolio ${label}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) fail(label, "must be a plain object");
	return value;
}

function arrayCopy<T>(values: readonly T[]): T[] {
	const result: T[] = [];
	for (let index = 0; index < values.length; index += 1) result[index] = values[index]!;
	return result;
}

function arrayMap<T, U>(values: readonly T[], map: (value: T, index: number) => U): U[] {
	const result: U[] = [];
	for (let index = 0; index < values.length; index += 1) result[index] = map(values[index]!, index);
	return result;
}

function arrayFilter<T>(values: readonly T[], keep: (value: T, index: number) => boolean): T[] {
	const result: T[] = [];
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index]!;
		if (keep(value, index)) result[result.length] = value;
	}
	return result;
}

function arrayFlatMap<T, U>(values: readonly T[], map: (value: T, index: number) => readonly U[]): U[] {
	const result: U[] = [];
	for (let index = 0; index < values.length; index += 1) {
		const mapped = map(values[index]!, index);
		for (let mappedIndex = 0; mappedIndex < mapped.length; mappedIndex += 1)
			result[result.length] = mapped[mappedIndex]!;
	}
	return result;
}

function arraySome<T>(values: readonly T[], predicate: (value: T, index: number) => boolean): boolean {
	for (let index = 0; index < values.length; index += 1) {
		if (predicate(values[index]!, index)) return true;
	}
	return false;
}

function arrayForEach<T>(values: readonly T[], visit: (value: T, index: number) => void): void {
	for (let index = 0; index < values.length; index += 1) visit(values[index]!, index);
}

function sortedArray<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
	const result = arrayCopy(values);
	ARRAY_SORT.call(result, compare);
	return result;
}

function contains<T>(values: readonly T[], target: T): boolean {
	for (let index = 0; index < values.length; index += 1) {
		if (values[index] === target) return true;
	}
	return false;
}

function joined(values: readonly string[], separator: string): string {
	let result = "";
	for (let index = 0; index < values.length; index += 1) {
		if (index > 0) result += separator;
		result += values[index]!;
	}
	return result;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const ownKeys = Reflect.ownKeys(value);
	const actual: string[] = [];
	for (const key of ownKeys) {
		if (typeof key !== "string") fail(label, "contains a non-enumerable or symbol field");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true)
			fail(label, "contains a non-enumerable or symbol field");
		actual[actual.length] = key;
	}
	const sortedActual = sortedArray(actual, (left, right) => left.localeCompare(right));
	const sortedExpected = sortedArray(keys, (left, right) => left.localeCompare(right));
	if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
		const unknown = arrayFilter(sortedActual, (key) => !contains(sortedExpected, key));
		fail(label, unknown.length > 0 ? `unknown field(s): ${joined(unknown, ", ")}` : "has an incomplete field set");
	}
}

function text(value: unknown, label: string, maximum = MAX_TEXT_BYTES): string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0)
		fail(label, "must be non-empty text");
	const bytes = new TextEncoder().encode(value).byteLength;
	if (bytes > maximum) fail(label, `exceeds ${maximum} UTF-8 bytes`);
	return value;
}

function identifier(value: unknown, label: string): string {
	const result = text(value, label, 128);
	if (!ID.test(result)) fail(label, "has an invalid bounded identifier");
	return result;
}

function digest(value: unknown, label: string): string {
	const result = text(value, label, 64);
	if (!MAX_DIGEST.test(result)) fail(label, "must be a lowercase SHA-256 digest");
	return result;
}

function canonicalDigestValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value.replace(/\r\n?/g, "\n"));
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("AutoResearch portfolio digest contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length)
			throw new Error("AutoResearch portfolio digest contains a sparse array");
		const entries: string[] = [];
		for (let index = 0; index < value.length; index += 1) entries[index] = canonicalDigestValue(value[index]);
		return `[${joined(entries, ",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const prototype = Object.getPrototypeOf(value);
		if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0)
			throw new Error("AutoResearch portfolio digest contains an unsupported object");
		const entries = sortedArray(Object.entries(value), ([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		const serialized: string[] = [];
		for (let index = 0; index < entries.length; index += 1) {
			const [key, child] = entries[index]!;
			serialized[index] = `${JSON.stringify(key)}:${canonicalDigestValue(child)}`;
		}
		return `{${joined(serialized, ",")}}`;
	}
	throw new Error("AutoResearch portfolio digest contains an unsupported value");
}

function safeDigestObject(value: unknown): string {
	return sha256Hex(new TextEncoder().encode(canonicalDigestValue(value)));
}

function digestWithoutField(value: object, field: string): string {
	const payload: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key !== field) payload[key] = child;
	}
	return safeDigestObject(payload);
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
		fail(label, "must be finite and bounded");
	}
	return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
	const result = finiteNumber(value, label);
	if (result < 0) fail(label, "must be non-negative");
	return result;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		fail(label, "must be a positive integer");
	return value;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
	const result = positiveInteger(value, label);
	if (result > maximum) fail(label, `must be at most ${maximum}`);
	return result;
}

function scope(value: unknown, label: string): AutoResearchPortfolioScope {
	if (value !== "terminal" && value !== "learning") fail(label, "must be terminal or learning");
	return value;
}

function closedArray(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value)) fail(label, "must be an array");
	if (Object.getPrototypeOf(value) !== Array.prototype) fail(label, "must retain the standard array prototype");
	if (value.length > MAX_ARRAY_ENTRIES) fail(label, `must contain at most ${MAX_ARRAY_ENTRIES} entries`);
	const presentIndexes = new Set<number>();
	for (const key of Reflect.ownKeys(value)) {
		if (key === "length") {
			if (Object.prototype.propertyIsEnumerable.call(value, key)) fail(label, "length must remain non-enumerable");
			continue;
		}
		if (typeof key !== "string") fail(label, "must not contain symbol fields");
		if (!/^(0|[1-9][0-9]*)$/u.test(key)) fail(label, `unknown array field: ${key}`);
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key)
			fail(label, `invalid array index: ${key}`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			descriptor.enumerable !== true ||
			descriptor.writable !== true ||
			!("value" in descriptor)
		)
			fail(label, `array index ${key} must be an own enumerable writable data property`);
		presentIndexes.add(index);
	}
	if (presentIndexes.size !== value.length) fail(label, "must be dense and contain no hidden entries");
	return value;
}

function stringArray(
	value: unknown,
	label: string,
	options: { readonly identifiers?: boolean; readonly paths?: boolean } = {},
): readonly string[] {
	const entries = closedArray(value, label);
	const result = arrayMap(entries, (entry, index) => {
		const item =
			options.identifiers === true ? identifier(entry, `${label}[${index}]`) : text(entry, `${label}[${index}]`);
		if (options.paths === true) {
			if (
				new TextEncoder().encode(item).byteLength > MAX_PATH_BYTES ||
				!RELATIVE_PATH.test(item) ||
				item.includes("..")
			) {
				fail(`${label}[${index}]`, "must be a safe relative path");
			}
		}
		return item;
	});
	if (new Set(result).size !== result.length) fail(label, "must not contain duplicates");
	return result;
}

function sortedStrings(values: readonly string[]): readonly string[] {
	return sortedArray(values, (left, right) => left.localeCompare(right));
}

function ensureUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) fail(label, "must not contain duplicates");
}

function sameSplitClosureRoots(
	left: AutoResearchPortfolioSplitClosureRoots,
	right: AutoResearchPortfolioSplitClosureRoots,
): boolean {
	return left.training === right.training && left.validation === right.validation && left.holdout === right.holdout;
}

function locked(value: unknown, label: string): true {
	if (value !== true) fail(label, "must remain locked");
	return true;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		fail(label, "must be a non-negative integer");
	return value;
}

function isoTimestamp(value: unknown, label: string): string {
	const result = text(value, label, 128);
	if (!/^\d{4}-\d{2}-\d{2}T/u.test(result) || !Number.isFinite(Date.parse(result)))
		fail(label, "must be an ISO-8601 timestamp");
	return result;
}

function datasetCoverage(value: unknown, label: string): AutoResearchPortfolioDatasetCoverage {
	if (
		value !== "complete" &&
		value !== "provider_empty" &&
		value !== "partial_coverage" &&
		value !== "unknown" &&
		value !== "missing"
	)
		fail(label, "must distinguish complete, provider_empty, partial_coverage, unknown, or missing");
	return value;
}

function gapClassification(value: unknown, label: string): AutoResearchPortfolioDatasetGapClassification {
	if (
		value !== "none" &&
		value !== "provider_empty" &&
		value !== "partial_coverage" &&
		value !== "unknown" &&
		value !== "missing"
	)
		fail(label, "must distinguish none, provider_empty, partial_coverage, unknown, or missing");
	return value;
}

function modelAccessAuthority(value: unknown, label: string): AutoResearchPortfolioModelAccessAuthority {
	if (
		value !== "training_workers_training_only" &&
		value !== "validation_evaluator_host_only" &&
		value !== "holdout_host_aggregate_only"
	)
		fail(label, "has an invalid model access authority");
	return value;
}

function datasetLifecycle(value: unknown, label: string): AutoResearchPortfolioDatasetLifecycle {
	if (value !== "in_progress" && value !== "sealed" && value !== "superseded" && value !== "quarantined")
		fail(label, "must be in_progress, sealed, superseded, or quarantined");
	return value;
}

function parseRestoreVerification(value: unknown, label: string): AutoResearchPortfolioRestoreVerification {
	const item = record(value, label);
	exactKeys(item, ["locked", "independentlyRestored", "independentlyRehashed", "verificationEvidenceDigest"], label);
	if (typeof item.independentlyRestored !== "boolean")
		fail(`${label}.independentlyRestored`, "must be boolean evidence");
	if (typeof item.independentlyRehashed !== "boolean")
		fail(`${label}.independentlyRehashed`, "must be boolean evidence");
	return {
		locked: locked(item.locked, `${label}.locked`),
		independentlyRestored: item.independentlyRestored,
		independentlyRehashed: item.independentlyRehashed,
		verificationEvidenceDigest:
			item.verificationEvidenceDigest === null
				? null
				: digest(item.verificationEvidenceDigest, `${label}.verificationEvidenceDigest`),
	};
}

function parseSplitClosureRoots(value: unknown, label: string): AutoResearchPortfolioSplitClosureRoots {
	const item = record(value, label);
	exactKeys(item, ["training", "validation", "holdout"], label);
	const training = digest(item.training, `${label}.training`);
	const validation = digest(item.validation, `${label}.validation`);
	const holdout = digest(item.holdout, `${label}.holdout`);
	if (new Set([training, validation, holdout]).size !== 3)
		fail(label, "training, validation, and holdout closure roots must be distinct");
	return { training, validation, holdout };
}

function parseSplitBoundaryPolicy(value: unknown, label: string): AutoResearchPortfolioSplitBoundaryPolicy {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"trainingEndExclusive",
			"validationStartInclusive",
			"validationEndExclusive",
			"holdoutStartInclusive",
			"holdoutEndExclusive",
			"policyDigest",
		],
		label,
	);
	const trainingEndExclusive = isoTimestamp(item.trainingEndExclusive, `${label}.trainingEndExclusive`);
	const validationStartInclusive = isoTimestamp(item.validationStartInclusive, `${label}.validationStartInclusive`);
	const validationEndExclusive = isoTimestamp(item.validationEndExclusive, `${label}.validationEndExclusive`);
	const holdoutStartInclusive = isoTimestamp(item.holdoutStartInclusive, `${label}.holdoutStartInclusive`);
	const holdoutEndExclusive = isoTimestamp(item.holdoutEndExclusive, `${label}.holdoutEndExclusive`);
	const trainingEnd = Date.parse(trainingEndExclusive);
	const validationStart = Date.parse(validationStartInclusive);
	const validationEnd = Date.parse(validationEndExclusive);
	const holdoutStart = Date.parse(holdoutStartInclusive);
	const holdoutEnd = Date.parse(holdoutEndExclusive);
	if (
		trainingEnd > validationStart ||
		validationStart >= validationEnd ||
		validationEnd > holdoutStart ||
		holdoutStart >= holdoutEnd
	)
		fail(label, "must define ordered, non-overlapping split intervals");
	const parsed: AutoResearchPortfolioSplitBoundaryPolicy = {
		locked: locked(item.locked, `${label}.locked`),
		trainingEndExclusive,
		validationStartInclusive,
		validationEndExclusive,
		holdoutStartInclusive,
		holdoutEndExclusive,
		policyDigest: digest(item.policyDigest, `${label}.policyDigest`),
	};
	if (parsed.policyDigest !== digestWithoutField(parsed, "policyDigest"))
		fail(`${label}.policyDigest`, "must equal the canonical split-boundary policy digest");
	return parsed;
}

function parseDatasetProvenance(value: unknown, label: string): AutoResearchPortfolioDatasetProvenance {
	const item = record(value, label);
	exactKeys(
		item,
		["sourceSystem", "sourceDataset", "ingestDigest", "lineageDigest", "provenanceReceiptDigest"],
		label,
	);
	return {
		sourceSystem: text(item.sourceSystem, `${label}.sourceSystem`, 256),
		sourceDataset: text(item.sourceDataset, `${label}.sourceDataset`, 256),
		ingestDigest: digest(item.ingestDigest, `${label}.ingestDigest`),
		lineageDigest: digest(item.lineageDigest, `${label}.lineageDigest`),
		provenanceReceiptDigest: digest(item.provenanceReceiptDigest, `${label}.provenanceReceiptDigest`),
	};
}

function parseDatasetArtifact(value: unknown, label: string): AutoResearchPortfolioDatasetArtifactBinding {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"split",
			"objectUri",
			"generation",
			"sha256",
			"bytes",
			"schemaVersion",
			"modality",
			"instrumentSet",
			"sourceTimeStart",
			"sourceTimeEnd",
			"validationResult",
			"coverage",
			"gapClassification",
			"lifecycle",
			"restoreVerification",
			"provenance",
			"closureRootDigest",
			"accessAuthority",
		],
		label,
	);
	if (item.split !== "training" && item.split !== "validation" && item.split !== "holdout")
		fail(`${label}.split`, "must be training, validation, or holdout");
	const objectUri = text(item.objectUri, `${label}.objectUri`, 4_096);
	if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/u.test(objectUri))
		fail(`${label}.objectUri`, "must be an immutable object URI");
	const sourceTimeStart = isoTimestamp(item.sourceTimeStart, `${label}.sourceTimeStart`);
	const sourceTimeEnd = isoTimestamp(item.sourceTimeEnd, `${label}.sourceTimeEnd`);
	const sourceStartMilliseconds = Date.parse(sourceTimeStart);
	const sourceEndMilliseconds = Date.parse(sourceTimeEnd);
	if (sourceEndMilliseconds <= sourceStartMilliseconds)
		fail(`${label}.sourceTimeEnd`, "must be later than sourceTimeStart");
	const validationResult = item.validationResult;
	if (validationResult !== "passed" && validationResult !== "failed" && validationResult !== "unknown")
		fail(`${label}.validationResult`, "must be passed, failed, or unknown");
	const coverage = datasetCoverage(item.coverage, `${label}.coverage`);
	const gap = gapClassification(item.gapClassification, `${label}.gapClassification`);
	const lifecycle = datasetLifecycle(item.lifecycle, `${label}.lifecycle`);
	const restoreVerification = parseRestoreVerification(item.restoreVerification, `${label}.restoreVerification`);
	if (lifecycle === "sealed" && validationResult !== "passed")
		fail(`${label}.validationResult`, "sealed closure-root authority requires passed validation");
	const expectedGap = coverage === "complete" ? "none" : coverage;
	if (gap !== expectedGap) fail(`${label}.gapClassification`, "must agree with the coverage classification");
	if (coverage === "complete" && validationResult !== "passed")
		fail(`${label}.validationResult`, "complete evidence requires passed validation");
	if ((coverage === "provider_empty" || coverage === "partial_coverage") && validationResult !== "passed")
		fail(`${label}.validationResult`, "provider_empty and partial_coverage require a completed validation result");
	if ((coverage === "unknown" || coverage === "missing") && validationResult !== "unknown")
		fail(`${label}.validationResult`, "unknown or missing evidence requires unknown validation");
	if (validationResult === "failed")
		fail(`${label}.validationResult`, "failed validation is a split/provenance boundary violation");
	if (
		lifecycle === "sealed" &&
		(!restoreVerification.independentlyRestored ||
			!restoreVerification.independentlyRehashed ||
			restoreVerification.verificationEvidenceDigest === null)
	)
		fail(`${label}.restoreVerification`, "sealed evidence requires independent restore and rehash verification");
	const instrumentSet = stringArray(item.instrumentSet, `${label}.instrumentSet`, { identifiers: true });
	if (instrumentSet.length === 0) fail(`${label}.instrumentSet`, "must contain at least one instrument");
	return {
		split: item.split,
		objectUri,
		generation: positiveInteger(item.generation, `${label}.generation`),
		sha256: digest(item.sha256, `${label}.sha256`),
		bytes: nonNegativeInteger(item.bytes, `${label}.bytes`),
		schemaVersion: text(item.schemaVersion, `${label}.schemaVersion`, 128),
		modality: text(item.modality, `${label}.modality`, 128),
		instrumentSet: sortedStrings(instrumentSet),
		sourceTimeStart,
		sourceTimeEnd,
		validationResult,
		coverage,
		gapClassification: gap,
		lifecycle,
		restoreVerification,
		provenance: parseDatasetProvenance(item.provenance, `${label}.provenance`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		accessAuthority: modelAccessAuthority(item.accessAuthority, `${label}.accessAuthority`),
	};
}

function parseModelAccess(value: unknown, label: string): AutoResearchPortfolioModelAccess {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"training",
			"validation",
			"holdout",
			"holdoutRowsVisible",
			"holdoutPerCaseFeedback",
			"holdoutReturns",
			"signedAggregateEvidence",
		],
		label,
	);
	if (item.training !== "training_workers_training_only") fail(`${label}.training`, "must be training-only");
	if (item.validation !== "validation_evaluator_host_only") fail(`${label}.validation`, "must be host-controlled");
	if (item.holdout !== "holdout_host_aggregate_only") fail(`${label}.holdout`, "must be aggregate-only host access");
	if (item.holdoutRowsVisible !== false) fail(`${label}.holdoutRowsVisible`, "must remain false");
	if (item.holdoutPerCaseFeedback !== false) fail(`${label}.holdoutPerCaseFeedback`, "must remain false");
	if (item.holdoutReturns !== "aggregate_signed_evidence_only")
		fail(`${label}.holdoutReturns`, "must return aggregate signed evidence only");
	if (item.signedAggregateEvidence !== true) fail(`${label}.signedAggregateEvidence`, "must remain true");
	return {
		training: "training_workers_training_only",
		validation: "validation_evaluator_host_only",
		holdout: "holdout_host_aggregate_only",
		holdoutRowsVisible: false,
		holdoutPerCaseFeedback: false,
		holdoutReturns: "aggregate_signed_evidence_only",
		signedAggregateEvidence: true,
	};
}

function parseDatasetSplitManifest(value: unknown, label: string): AutoResearchPortfolioDatasetSplitManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "split", "closureRootDigest", "artifacts"], label);
	if (item.split !== "training" && item.split !== "validation" && item.split !== "holdout")
		fail(`${label}.split`, "must be training, validation, or holdout");
	const rawArtifacts = closedArray(item.artifacts, `${label}.artifacts`);
	if (rawArtifacts.length === 0) fail(`${label}.artifacts`, "must be a bounded non-empty list");
	const artifacts = arrayMap(rawArtifacts, (entry, index) =>
		parseDatasetArtifact(entry, `${label}.artifacts[${index}]`),
	);
	if (arraySome(artifacts, (artifact) => artifact.split !== item.split))
		fail(`${label}.artifacts`, "every artifact must belong to its physical split manifest");
	const artifactUris = arrayMap(artifacts, (artifact) => artifact.objectUri);
	ensureUnique(artifactUris, `${label}.artifacts.objectUri`);
	const parsed: AutoResearchPortfolioDatasetSplitManifest = {
		locked: locked(item.locked, `${label}.locked`),
		split: item.split,
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		artifacts: sortedRecords(artifacts, (artifact) => artifact.objectUri),
	};
	return parsed;
}

function parseInputManifest(value: unknown, label: string): AutoResearchPortfolioInputManifest {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"evaluationEpoch",
			"manifestRevision",
			"closureRootDigest",
			"manifestDigest",
			"splitClosureRoots",
			"splitBoundaryPolicy",
			"training",
			"validation",
			"holdout",
			"modelAccess",
		],
		label,
	);
	const evaluationEpoch = positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`);
	const manifestRevision = positiveInteger(item.manifestRevision, `${label}.manifestRevision`);
	if (manifestRevision > evaluationEpoch)
		fail(label, "each input-manifest revision must be covered by a fresh evaluation epoch");
	const closureRootDigest = digest(item.closureRootDigest, `${label}.closureRootDigest`);
	const splitClosureRoots = parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`);
	const splitBoundaryPolicy = parseSplitBoundaryPolicy(item.splitBoundaryPolicy, `${label}.splitBoundaryPolicy`);
	const training = parseDatasetSplitManifest(item.training, `${label}.training`);
	const validation = parseDatasetSplitManifest(item.validation, `${label}.validation`);
	const holdout = parseDatasetSplitManifest(item.holdout, `${label}.holdout`);
	if (training.split !== "training") fail(`${label}.training.split`, "must be the training split manifest");
	if (validation.split !== "validation") fail(`${label}.validation.split`, "must be the validation split manifest");
	if (holdout.split !== "holdout") fail(`${label}.holdout.split`, "must be the holdout split manifest");
	const manifests = [training, validation, holdout] as const;
	for (const splitManifest of manifests) {
		const expectedRoot = splitClosureRoots[splitManifest.split];
		if (splitManifest.closureRootDigest !== expectedRoot)
			fail(`${label}.${splitManifest.split}.closureRootDigest`, "does not match its immutable split closure root");
		if (splitManifest.locked !== true)
			fail(`${label}.${splitManifest.split}.locked`, "split manifests must remain locked");
		for (const artifact of splitManifest.artifacts) {
			if (artifact.closureRootDigest !== expectedRoot)
				fail(
					`${label}.${splitManifest.split}.artifacts`,
					"artifact does not match its immutable split closure root",
				);
			if (artifact.lifecycle !== "sealed")
				fail(
					`${label}.${splitManifest.split}.artifacts.lifecycle`,
					"only sealed artifacts are usable by an active portfolio",
				);
		}
	}
	if (new Set([closureRootDigest, ...Object.values(splitClosureRoots)]).size !== 4)
		fail(label, "the overall portfolio root must be distinct from all split closure roots");
	const artifacts = arrayFlatMap(manifests, (splitManifest) => splitManifest.artifacts);
	const artifactUris = arrayMap(artifacts, (artifact) => artifact.objectUri);
	if (new Set(artifactUris).size !== artifacts.length)
		fail(label, "dataset artifacts must use physically separate immutable object URIs");
	const expectedAuthorities: Readonly<
		Record<AutoResearchPortfolioDatasetSplit, AutoResearchPortfolioModelAccessAuthority>
	> = {
		training: "training_workers_training_only",
		validation: "validation_evaluator_host_only",
		holdout: "holdout_host_aggregate_only",
	};
	for (const splitManifest of manifests) {
		for (const artifact of splitManifest.artifacts) {
			if (artifact.accessAuthority !== expectedAuthorities[splitManifest.split])
				fail(
					`${label}.${splitManifest.split}.artifacts.accessAuthority`,
					"violates the split model-access boundary",
				);
			const start = Date.parse(artifact.sourceTimeStart);
			const end = Date.parse(artifact.sourceTimeEnd);
			if (splitManifest.split === "training" && end > Date.parse(splitBoundaryPolicy.trainingEndExclusive))
				fail(`${label}.training.artifacts`, "must be bounded by the locked split-boundary policy");
			if (
				splitManifest.split === "validation" &&
				(start < Date.parse(splitBoundaryPolicy.validationStartInclusive) ||
					end > Date.parse(splitBoundaryPolicy.validationEndExclusive))
			)
				fail(`${label}.validation.artifacts`, "must be bounded by the locked split-boundary policy");
			if (
				splitManifest.split === "holdout" &&
				(start < Date.parse(splitBoundaryPolicy.holdoutStartInclusive) ||
					end > Date.parse(splitBoundaryPolicy.holdoutEndExclusive))
			)
				fail(`${label}.holdout.artifacts`, "must be bounded by the locked split-boundary policy");
		}
	}
	const parsed: AutoResearchPortfolioInputManifest = {
		locked: locked(item.locked, `${label}.locked`),
		evaluationEpoch,
		manifestRevision,
		closureRootDigest,
		manifestDigest: digest(item.manifestDigest, `${label}.manifestDigest`),
		splitClosureRoots,
		splitBoundaryPolicy,
		training,
		validation,
		holdout,
		modelAccess: parseModelAccess(item.modelAccess, `${label}.modelAccess`),
	};
	if (parsed.manifestDigest !== digestWithoutField(parsed, "manifestDigest"))
		fail(`${label}.manifestDigest`, "must equal the canonical input-manifest digest");
	return parsed;
}

function rejectParameterOnlyText(values: readonly string[], label: string): void {
	const textValue = joined(values, " ").toLowerCase();
	if (
		/parameter[ _-]?(only|sweep|tuning|hunt|search|variant)|hyperparameter|threshold[ _-]?(sweep|tuning)|weight[ _-]?(sweep|tuning)|temperature[ _-]?(sweep|tuning)/u.test(
			textValue,
		)
	) {
		fail(label, "parameter-only changes cannot be relabeled as mechanisms");
	}
}

function parseMetricValue(value: unknown, label: string): AutoResearchPortfolioMetricValue {
	const item = record(value, label);
	exactKeys(item, ["metricId", "value"], label);
	return {
		metricId: identifier(item.metricId, `${label}.metricId`),
		value: finiteNumber(item.value, `${label}.value`),
	};
}

function parseAcceptanceRequirement(value: unknown, label: string): AutoResearchPortfolioAcceptanceRequirement {
	const item = record(value, label);
	exactKeys(item, ["requirementId", "statement", "locked", "requirementDigest"], label);
	const parsed = {
		requirementId: identifier(item.requirementId, `${label}.requirementId`),
		statement: text(item.statement, `${label}.statement`),
		locked: locked(item.locked, `${label}.locked`),
		requirementDigest: digest(item.requirementDigest, `${label}.requirementDigest`),
	};
	if (parsed.requirementDigest !== digestWithoutField(parsed, "requirementDigest"))
		fail(`${label}.requirementDigest`, "must equal the canonical acceptance requirement digest");
	return parsed;
}

function parseMetric(value: unknown, label: string): AutoResearchPortfolioMetric {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"metricId",
			"name",
			"requirementId",
			"direction",
			"target",
			"unit",
			"locked",
			"evaluationEpoch",
			"metricRevision",
			"closureRootDigest",
			"inputManifestDigest",
			"splitClosureRoots",
		],
		label,
	);
	if (item.direction !== "lower" && item.direction !== "higher") fail(`${label}.direction`, "is invalid");
	return {
		metricId: identifier(item.metricId, `${label}.metricId`),
		name: text(item.name, `${label}.name`),
		requirementId: identifier(item.requirementId, `${label}.requirementId`),
		direction: item.direction,
		target: finiteNumber(item.target, `${label}.target`),
		unit: text(item.unit, `${label}.unit`, 128),
		locked: locked(item.locked, `${label}.locked`),
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		metricRevision: positiveInteger(item.metricRevision, `${label}.metricRevision`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		inputManifestDigest: digest(item.inputManifestDigest, `${label}.inputManifestDigest`),
		splitClosureRoots: parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`),
	};
}

function parseBaseline(value: unknown, label: string): AutoResearchPortfolioBaselineManifest {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"measurementId",
			"metricValues",
			"evidenceDigest",
			"evaluationEpoch",
			"closureRootDigest",
			"inputManifestDigest",
			"splitClosureRoots",
		],
		label,
	);
	const rawMetricValues = closedArray(item.metricValues, `${label}.metricValues`);
	if (rawMetricValues.length === 0) fail(`${label}.metricValues`, "must be a bounded non-empty vector");
	const metricValues = arrayMap(rawMetricValues, (entry, index) =>
		parseMetricValue(entry, `${label}.metricValues[${index}]`),
	);
	ensureUnique(
		arrayMap(metricValues, (entry) => entry.metricId),
		`${label}.metricValues`,
	);
	return {
		locked: locked(item.locked, `${label}.locked`),
		measurementId: identifier(item.measurementId, `${label}.measurementId`),
		metricValues,
		evidenceDigest: digest(item.evidenceDigest, `${label}.evidenceDigest`),
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		inputManifestDigest: digest(item.inputManifestDigest, `${label}.inputManifestDigest`),
		splitClosureRoots: parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`),
	};
}

function parseEvaluator(value: unknown, label: string): AutoResearchPortfolioEvaluatorManifest {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"evaluatorId",
			"sourceDigest",
			"inputDigest",
			"environmentDigest",
			"evaluatorDigest",
			"evaluationEpoch",
			"evaluatorRevision",
			"closureRootDigest",
			"inputManifestDigest",
			"splitClosureRoots",
		],
		label,
	);
	const parsed: AutoResearchPortfolioEvaluatorManifest = {
		locked: locked(item.locked, `${label}.locked`),
		evaluatorId: identifier(item.evaluatorId, `${label}.evaluatorId`),
		sourceDigest: digest(item.sourceDigest, `${label}.sourceDigest`),
		inputDigest: digest(item.inputDigest, `${label}.inputDigest`),
		environmentDigest: digest(item.environmentDigest, `${label}.environmentDigest`),
		evaluatorDigest: digest(item.evaluatorDigest, `${label}.evaluatorDigest`),
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		evaluatorRevision: positiveInteger(item.evaluatorRevision, `${label}.evaluatorRevision`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		inputManifestDigest: digest(item.inputManifestDigest, `${label}.inputManifestDigest`),
		splitClosureRoots: parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`),
	};
	if (parsed.evaluatorDigest !== digestWithoutField(parsed, "evaluatorDigest"))
		fail(`${label}.evaluatorDigest`, "must equal the canonical evaluator digest");
	return parsed;
}

function parseParser(value: unknown, label: string): AutoResearchPortfolioParserManifest {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"parserId",
			"kind",
			"metricKeys",
			"parserDigest",
			"evaluationEpoch",
			"inputManifestRevision",
			"closureRootDigest",
			"inputManifestDigest",
			"splitClosureRoots",
		],
		label,
	);
	if (item.kind !== "json_object" && item.kind !== "scalar_number") fail(`${label}.kind`, "is invalid");
	const metricKeys = stringArray(item.metricKeys, `${label}.metricKeys`, { identifiers: true });
	if (metricKeys.length === 0) fail(`${label}.metricKeys`, "must be non-empty");
	const parsed: AutoResearchPortfolioParserManifest = {
		locked: locked(item.locked, `${label}.locked`),
		parserId: identifier(item.parserId, `${label}.parserId`),
		kind: item.kind,
		metricKeys: sortedStrings(metricKeys),
		parserDigest: digest(item.parserDigest, `${label}.parserDigest`),
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		inputManifestRevision: positiveInteger(item.inputManifestRevision, `${label}.inputManifestRevision`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		inputManifestDigest: digest(item.inputManifestDigest, `${label}.inputManifestDigest`),
		splitClosureRoots: parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`),
	};
	if (parsed.parserDigest !== digestWithoutField(parsed, "parserDigest"))
		fail(`${label}.parserDigest`, "must equal the canonical parser digest");
	return parsed;
}

function parseCommand(value: unknown, label: string): AutoResearchPortfolioCommandManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "argv", "shell", "cwd", "commandDigest"], label);
	if (item.shell !== false) fail(`${label}.shell`, "must be false");
	const rawArgv = closedArray(item.argv, `${label}.argv`);
	if (rawArgv.length === 0 || rawArgv.length > MAX_COMMAND_ARGUMENTS)
		fail(`${label}.argv`, "must be a bounded non-empty argv");
	const argv = arrayMap(rawArgv, (entry, index) => text(entry, `${label}.argv[${index}]`, 4_096));
	const parsed: AutoResearchPortfolioCommandManifest = {
		locked: locked(item.locked, `${label}.locked`),
		argv,
		shell: false,
		cwd: text(item.cwd, `${label}.cwd`, MAX_PATH_BYTES),
		commandDigest: digest(item.commandDigest, `${label}.commandDigest`),
	};
	if (parsed.commandDigest !== digestWithoutField(parsed, "commandDigest"))
		fail(`${label}.commandDigest`, "must equal the canonical command digest");
	return parsed;
}

function parseRepeatability(value: unknown, label: string): AutoResearchPortfolioRepeatabilityManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "runs", "aggregation", "seed", "maxVariance"], label);
	if (item.aggregation !== "exact" && item.aggregation !== "mean" && item.aggregation !== "median")
		fail(`${label}.aggregation`, "is invalid");
	return {
		locked: locked(item.locked, `${label}.locked`),
		runs: boundedInteger(item.runs, `${label}.runs`, MAX_ARRAY_ENTRIES),
		aggregation: item.aggregation,
		seed: text(item.seed, `${label}.seed`, 256),
		maxVariance: nonNegativeNumber(item.maxVariance, `${label}.maxVariance`),
	};
}

function parseUncertainty(value: unknown, label: string): AutoResearchPortfolioUncertaintyManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "method", "confidence", "maxWidth", "maxVariance"], label);
	if (item.method !== "bootstrap" && item.method !== "analytic" && item.method !== "deterministic")
		fail(`${label}.method`, "is invalid");
	const confidence = finiteNumber(item.confidence, `${label}.confidence`);
	if (confidence <= 0 || confidence > 1) fail(`${label}.confidence`, "must be in (0, 1]");
	return {
		locked: locked(item.locked, `${label}.locked`),
		method: item.method,
		confidence,
		maxWidth: nonNegativeNumber(item.maxWidth, `${label}.maxWidth`),
		maxVariance: nonNegativeNumber(item.maxVariance, `${label}.maxVariance`),
	};
}

function parseHoldout(value: unknown, label: string): AutoResearchPortfolioOpaqueHoldoutManifest {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"locked",
			"policy",
			"candidateVisible",
			"handleDigest",
			"inputDigest",
			"resolverDigest",
			"evaluationEpoch",
			"closureRootDigest",
			"splitClosureRoots",
		],
		label,
	);
	if (item.policy !== "host_only") fail(`${label}.policy`, "must be host_only");
	if (item.candidateVisible !== false) fail(`${label}.candidateVisible`, "must remain opaque to candidates");
	return {
		locked: locked(item.locked, `${label}.locked`),
		policy: "host_only",
		candidateVisible: false,
		handleDigest: digest(item.handleDigest, `${label}.handleDigest`),
		inputDigest: digest(item.inputDigest, `${label}.inputDigest`),
		resolverDigest: digest(item.resolverDigest, `${label}.resolverDigest`),
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		closureRootDigest: digest(item.closureRootDigest, `${label}.closureRootDigest`),
		splitClosureRoots: parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`),
	};
}

function parseManifestStrings(value: unknown, key: "criteria" | "checks", label: string): readonly string[] {
	return sortedStrings(stringArray(value, `${label}.${key}`));
}

function parseFalsification(value: unknown, label: string): AutoResearchPortfolioFalsificationManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "criteria", "manifestDigest"], label);
	const criteria = parseManifestStrings(item.criteria, "criteria", label);
	if (criteria.length === 0) fail(`${label}.criteria`, "must be non-empty");
	const parsed = {
		locked: locked(item.locked, `${label}.locked`),
		criteria,
		manifestDigest: digest(item.manifestDigest, `${label}.manifestDigest`),
	};
	if (parsed.manifestDigest !== digestWithoutField(parsed, "manifestDigest"))
		fail(`${label}.manifestDigest`, "must equal the canonical falsification manifest digest");
	return parsed;
}

function parseAdversarial(value: unknown, label: string): AutoResearchPortfolioAdversarialManifest {
	const item = record(value, label);
	exactKeys(item, ["locked", "checks", "manifestDigest"], label);
	const checks = parseManifestStrings(item.checks, "checks", label);
	if (checks.length === 0) fail(`${label}.checks`, "must be non-empty");
	const parsed = {
		locked: locked(item.locked, `${label}.locked`),
		checks,
		manifestDigest: digest(item.manifestDigest, `${label}.manifestDigest`),
	};
	if (parsed.manifestDigest !== digestWithoutField(parsed, "manifestDigest"))
		fail(`${label}.manifestDigest`, "must equal the canonical adversarial manifest digest");
	return parsed;
}

function parseGoal(value: unknown, label: string): AutoResearchPortfolioGoal {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"goalId",
			"domainId",
			"title",
			"description",
			"scope",
			"metrics",
			"baseline",
			"evaluator",
			"parser",
			"command",
			"repeatability",
			"uncertainty",
			"opaqueHoldout",
			"falsification",
			"adversarial",
		],
		label,
	);
	const rawMetrics = closedArray(item.metrics, `${label}.metrics`);
	if (rawMetrics.length === 0) fail(`${label}.metrics`, "must be a bounded non-empty list");
	const metrics = arrayMap(rawMetrics, (entry, index) => parseMetric(entry, `${label}.metrics[${index}]`));
	ensureUnique(
		arrayMap(metrics, (entry) => entry.metricId),
		`${label}.metrics`,
	);
	const metricIds = sortedStrings(arrayMap(metrics, (entry) => entry.metricId));
	const baseline = parseBaseline(item.baseline, `${label}.baseline`);
	const parser = parseParser(item.parser, `${label}.parser`);
	if (
		JSON.stringify(sortedStrings(arrayMap(baseline.metricValues, (entry) => entry.metricId))) !==
		JSON.stringify(metricIds)
	)
		fail(`${label}.baseline`, "must cover exactly the locked metrics for this goal");
	if (JSON.stringify(sortedStrings(parser.metricKeys)) !== JSON.stringify(metricIds))
		fail(`${label}.parser`, "must expose exactly the locked metrics for this goal");
	return {
		goalId: identifier(item.goalId, `${label}.goalId`),
		domainId: identifier(item.domainId, `${label}.domainId`),
		title: text(item.title, `${label}.title`),
		description: text(item.description, `${label}.description`),
		scope: scope(item.scope, `${label}.scope`),
		metrics: sortedArray(metrics, (left, right) => left.metricId.localeCompare(right.metricId)),
		baseline,
		evaluator: parseEvaluator(item.evaluator, `${label}.evaluator`),
		parser,
		command: parseCommand(item.command, `${label}.command`),
		repeatability: parseRepeatability(item.repeatability, `${label}.repeatability`),
		uncertainty: parseUncertainty(item.uncertainty, `${label}.uncertainty`),
		opaqueHoldout: parseHoldout(item.opaqueHoldout, `${label}.opaqueHoldout`),
		falsification: parseFalsification(item.falsification, `${label}.falsification`),
		adversarial: parseAdversarial(item.adversarial, `${label}.adversarial`),
	};
}

function parseRelation(value: unknown, label: string): AutoResearchPortfolioGoalRelation {
	const item = record(value, label);
	exactKeys(item, ["fromGoalId", "toGoalId", "relation", "rationale"], label);
	if (
		item.relation !== "complementary" &&
		item.relation !== "competing" &&
		item.relation !== "prerequisite" &&
		item.relation !== "conflict"
	)
		fail(`${label}.relation`, "must be complementary, competing, prerequisite, or conflict");
	return {
		fromGoalId: identifier(item.fromGoalId, `${label}.fromGoalId`),
		toGoalId: identifier(item.toGoalId, `${label}.toGoalId`),
		relation: item.relation,
		rationale: text(item.rationale, `${label}.rationale`),
	};
}

function parseTier(value: unknown, label: string): AutoResearchPortfolioLexicographicTier {
	const item = record(value, label);
	exactKeys(item, ["tier", "goalIds"], label);
	const tier = positiveInteger(item.tier, `${label}.tier`);
	const goalIds = stringArray(item.goalIds, `${label}.goalIds`, { identifiers: true });
	if (goalIds.length === 0) fail(`${label}.goalIds`, "must be non-empty");
	return { tier, goalIds: sortedStrings(goalIds) };
}

function parseBoundary(value: unknown, label: string): AutoResearchPortfolioHardBoundary {
	const item = record(value, label);
	exactKeys(item, ["boundaryId", "statement", "scope", "locked"], label);
	return {
		boundaryId: identifier(item.boundaryId, `${label}.boundaryId`),
		statement: text(item.statement, `${label}.statement`),
		scope: scope(item.scope, `${label}.scope`),
		locked: locked(item.locked, `${label}.locked`),
	};
}

function parseInvariant(value: unknown, label: string): AutoResearchPortfolioInvariant {
	const item = record(value, label);
	exactKeys(item, ["invariantId", "statement", "scope", "locked", "checkDigest"], label);
	return {
		invariantId: identifier(item.invariantId, `${label}.invariantId`),
		statement: text(item.statement, `${label}.statement`),
		scope: scope(item.scope, `${label}.scope`),
		locked: locked(item.locked, `${label}.locked`),
		checkDigest: digest(item.checkDigest, `${label}.checkDigest`),
	};
}

function parseNonGoal(value: unknown, label: string): AutoResearchPortfolioNonGoal {
	const item = record(value, label);
	exactKeys(item, ["nonGoalId", "statement", "scope"], label);
	return {
		nonGoalId: identifier(item.nonGoalId, `${label}.nonGoalId`),
		statement: text(item.statement, `${label}.statement`),
		scope: scope(item.scope, `${label}.scope`),
	};
}

function parseBudgets(value: unknown, label: string): AutoResearchPortfolioBudgets {
	const item = record(value, label);
	exactKeys(
		item,
		["maxCandidates", "maxMeasurements", "maxWallSeconds", "maxCostMicrounits", "maxParallelCandidates", "maxTokens"],
		label,
	);
	return {
		maxCandidates: boundedInteger(item.maxCandidates, `${label}.maxCandidates`, MAX_ARRAY_ENTRIES),
		maxMeasurements: boundedInteger(
			item.maxMeasurements,
			`${label}.maxMeasurements`,
			MAX_ARRAY_ENTRIES * MAX_ARRAY_ENTRIES,
		),
		maxWallSeconds: positiveInteger(item.maxWallSeconds, `${label}.maxWallSeconds`),
		maxCostMicrounits: nonNegativeNumber(item.maxCostMicrounits, `${label}.maxCostMicrounits`),
		maxParallelCandidates: boundedInteger(
			item.maxParallelCandidates,
			`${label}.maxParallelCandidates`,
			MAX_ARRAY_ENTRIES,
		),
		maxTokens: positiveInteger(item.maxTokens, `${label}.maxTokens`),
	};
}

function parseSafety(value: unknown, label: string): AutoResearchPortfolioSafety {
	const item = record(value, label);
	exactKeys(
		item,
		["locked", "network", "externalEffects", "requireOpaqueHoldout", "requireAdversarialReview", "maxUncertainty"],
		label,
	);
	if (item.network !== "disabled" && item.network !== "authorized") fail(`${label}.network`, "is invalid");
	if (item.externalEffects !== "none" && item.externalEffects !== "host_gated")
		fail(`${label}.externalEffects`, "is invalid");
	if (item.requireOpaqueHoldout !== true) fail(`${label}.requireOpaqueHoldout`, "must be true");
	if (item.requireAdversarialReview !== true) fail(`${label}.requireAdversarialReview`, "must be true");
	return {
		locked: locked(item.locked, `${label}.locked`),
		network: item.network,
		externalEffects: item.externalEffects,
		requireOpaqueHoldout: true,
		requireAdversarialReview: true,
		maxUncertainty: nonNegativeNumber(item.maxUncertainty, `${label}.maxUncertainty`),
	};
}

function parseScopePartition(value: unknown, label: string): AutoResearchPortfolioScopePartition {
	const item = record(value, label);
	exactKeys(item, ["partitionId", "scope", "paths", "dataDigests", "mutableBy"], label);
	if (item.mutableBy !== "candidate" && item.mutableBy !== "host" && item.mutableBy !== "immutable")
		fail(`${label}.mutableBy`, "is invalid");
	const paths = stringArray(item.paths, `${label}.paths`, { paths: true });
	if (paths.length === 0) fail(`${label}.paths`, "must be non-empty");
	const dataDigests = stringArray(item.dataDigests, `${label}.dataDigests`);
	arrayForEach(dataDigests, (entry, index) => {
		digest(entry, `${label}.dataDigests[${index}]`);
	});
	return {
		partitionId: identifier(item.partitionId, `${label}.partitionId`),
		scope: scope(item.scope, `${label}.scope`),
		paths: sortedStrings(paths),
		dataDigests: sortedStrings(dataDigests),
		mutableBy: item.mutableBy,
	};
}

function parseSolutionFamily(value: unknown, label: string): AutoResearchPortfolioSolutionFamily {
	const item = record(value, label);
	exactKeys(item, ["familyId", "name", "mechanismClass"], label);
	const name = text(item.name, `${label}.name`);
	const mechanismClass = text(item.mechanismClass, `${label}.mechanismClass`, 256);
	rejectParameterOnlyText([name, mechanismClass], label);
	return {
		familyId: identifier(item.familyId, `${label}.familyId`),
		name,
		mechanismClass,
	};
}

function parseAncestry(value: unknown, label: string): AutoResearchPortfolioAncestry {
	const item = record(value, label);
	exactKeys(item, ["parentCandidateIds", "baseDigest", "lineageDigest"], label);
	const parentCandidateIds = stringArray(item.parentCandidateIds, `${label}.parentCandidateIds`, {
		identifiers: true,
	});
	return {
		parentCandidateIds: sortedStrings(parentCandidateIds),
		baseDigest: digest(item.baseDigest, `${label}.baseDigest`),
		lineageDigest: digest(item.lineageDigest, `${label}.lineageDigest`),
	};
}

function parseCausalMechanism(value: unknown, label: string): AutoResearchPortfolioCausalMechanism {
	const item = record(value, label);
	exactKeys(
		item,
		["hypothesis", "intervention", "expectedObservation", "falsificationCondition", "mechanismDigest"],
		label,
	);
	const hypothesis = text(item.hypothesis, `${label}.hypothesis`);
	const intervention = text(item.intervention, `${label}.intervention`);
	const expectedObservation = text(item.expectedObservation, `${label}.expectedObservation`);
	const falsificationCondition = text(item.falsificationCondition, `${label}.falsificationCondition`);
	rejectParameterOnlyText([hypothesis, intervention, expectedObservation, falsificationCondition], label);
	return {
		hypothesis,
		intervention,
		expectedObservation,
		falsificationCondition,
		mechanismDigest: digest(item.mechanismDigest, `${label}.mechanismDigest`),
	};
}

function parseChange(value: unknown, label: string): AutoResearchPortfolioChange {
	const item = record(value, label);
	exactKeys(item, ["kind", "changedPaths", "parameterChanges", "changeDigest"], label);
	if (item.kind !== "mechanism")
		fail(`${label}.kind`, "parameter-only or relabeled changes are not contract mechanisms");
	const changedPaths = stringArray(item.changedPaths, `${label}.changedPaths`, { paths: true });
	if (changedPaths.length === 0) fail(`${label}.changedPaths`, "must be non-empty");
	const parameterChanges = stringArray(item.parameterChanges, `${label}.parameterChanges`);
	if (parameterChanges.length > 0) fail(`${label}.parameterChanges`, "parameter-only changes are not admissible");
	return {
		kind: "mechanism",
		changedPaths: sortedStrings(changedPaths),
		parameterChanges: [],
		changeDigest: digest(item.changeDigest, `${label}.changeDigest`),
	};
}

function parseCandidate(value: unknown, label: string): AutoResearchPortfolioCandidate {
	const item = record(value, label);
	exactKeys(
		item,
		["candidateId", "goalIds", "solutionFamily", "ancestry", "causalMechanism", "change", "scope"],
		label,
	);
	const goalIds = stringArray(item.goalIds, `${label}.goalIds`, { identifiers: true });
	if (goalIds.length === 0) fail(`${label}.goalIds`, "must be non-empty");
	return {
		candidateId: identifier(item.candidateId, `${label}.candidateId`),
		goalIds: sortedStrings(goalIds),
		solutionFamily: parseSolutionFamily(item.solutionFamily, `${label}.solutionFamily`),
		ancestry: parseAncestry(item.ancestry, `${label}.ancestry`),
		causalMechanism: parseCausalMechanism(item.causalMechanism, `${label}.causalMechanism`),
		change: parseChange(item.change, `${label}.change`),
		scope: scope(item.scope, `${label}.scope`),
	};
}

function parseVectorValue(value: unknown, label: string): AutoResearchPortfolioVectorMeasurement {
	const item = record(value, label);
	exactKeys(item, ["metricId", "value"], label);
	return {
		metricId: identifier(item.metricId, `${label}.metricId`),
		value: finiteNumber(item.value, `${label}.value`),
	};
}

function parseConfidenceInterval(value: unknown, label: string): AutoResearchPortfolioConfidenceInterval {
	const item = record(value, label);
	exactKeys(item, ["lower", "upper", "level"], label);
	const lower = finiteNumber(item.lower, `${label}.lower`);
	const upper = finiteNumber(item.upper, `${label}.upper`);
	const level = finiteNumber(item.level, `${label}.level`);
	if (lower > upper) fail(label, "must have lower <= upper");
	if (level <= 0 || level > 1) fail(`${label}.level`, "must be in (0, 1]");
	return { lower, upper, level };
}

function validateMeasurementBinding(
	measurement: AutoResearchPortfolioMeasurement,
	context: AutoResearchPortfolioMeasurementBindingContext,
	label: string,
): void {
	const confidenceLevel = finiteNumber(context.confidenceLevel, `${label}.context.confidenceLevel`);
	if (confidenceLevel <= 0 || confidenceLevel > 1) fail(`${label}.context.confidenceLevel`, "must be in (0, 1]");
	if (measurement.confidenceInterval.level !== confidenceLevel)
		fail(`${label}.confidenceInterval.level`, "must equal the locked goal uncertainty confidence");
	if (context.evaluationEpoch !== undefined && measurement.evaluationEpoch !== context.evaluationEpoch)
		fail(`${label}.evaluationEpoch`, "does not match the locked evaluation epoch");
	if (context.inputManifestDigest !== undefined && measurement.inputManifestDigest !== context.inputManifestDigest)
		fail(`${label}.inputManifestDigest`, "does not match the locked input manifest");
	if (
		context.splitClosureRoots !== undefined &&
		!sameSplitClosureRoots(measurement.splitClosureRoots, context.splitClosureRoots)
	)
		fail(`${label}.splitClosureRoots`, "do not match the locked split closure roots");
}

function parseMeasurement(
	value: unknown,
	label: string,
	context?: AutoResearchPortfolioMeasurementBindingContext,
): AutoResearchPortfolioMeasurement {
	const item = record(value, label);
	exactKeys(
		item,
		[
			"measurementId",
			"goalId",
			"candidateId",
			"scope",
			"kind",
			"vector",
			"repeatIndex",
			"sampleCount",
			"evaluationEpoch",
			"inputManifestDigest",
			"splitClosureRoots",
			"confidenceInterval",
			"variance",
			"runCount",
			"aggregation",
			"inputDigest",
			"evaluatorDigest",
			"parserDigest",
			"commandDigest",
			"workspaceDigest",
			"evidenceDigests",
			"measuredAt",
			"measurementDigest",
		],
		label,
	);
	if (item.candidateId !== null && typeof item.candidateId !== "string")
		fail(`${label}.candidateId`, "must be null or an identifier");
	if (
		item.kind !== "baseline" &&
		item.kind !== "candidate" &&
		item.kind !== "holdout" &&
		item.kind !== "replay" &&
		item.kind !== "adversarial"
	)
		fail(`${label}.kind`, "is invalid");
	if (item.kind === "baseline" && item.candidateId !== null)
		fail(`${label}.candidateId`, "baseline measurements cannot name a candidate");
	if (item.kind === "candidate" && item.candidateId === null)
		fail(`${label}.candidateId`, "candidate measurements must name a candidate");
	const rawVector = closedArray(item.vector, `${label}.vector`);
	if (rawVector.length === 0) fail(`${label}.vector`, "must be a bounded non-empty vector");
	const vector = arrayMap(rawVector, (entry, index) => parseVectorValue(entry, `${label}.vector[${index}]`));
	ensureUnique(
		arrayMap(vector, (entry) => entry.metricId),
		`${label}.vector`,
	);
	const evidenceDigests = stringArray(item.evidenceDigests, `${label}.evidenceDigests`);
	if (evidenceDigests.length === 0) fail(`${label}.evidenceDigests`, "must be non-empty");
	arrayForEach(evidenceDigests, (entry, index) => {
		digest(entry, `${label}.evidenceDigests[${index}]`);
	});
	if (item.aggregation !== "exact" && item.aggregation !== "mean" && item.aggregation !== "median")
		fail(`${label}.aggregation`, "is invalid");
	const inputManifestDigest = digest(item.inputManifestDigest, `${label}.inputManifestDigest`);
	const inputDigest = digest(item.inputDigest, `${label}.inputDigest`);
	if (inputDigest !== inputManifestDigest)
		fail(`${label}.inputDigest`, "must match the immutable inputManifestDigest");
	const sampleCount = boundedInteger(item.sampleCount, `${label}.sampleCount`, MAX_ARRAY_ENTRIES);
	const runCount = boundedInteger(item.runCount, `${label}.runCount`, MAX_ARRAY_ENTRIES);
	if (sampleCount < runCount) fail(`${label}.sampleCount`, "must be at least runCount");
	const confidenceInterval = parseConfidenceInterval(item.confidenceInterval, `${label}.confidenceInterval`);
	if (arraySome(vector, (entry) => entry.value < confidenceInterval.lower || entry.value > confidenceInterval.upper))
		fail(`${label}.vector`, "every value must be contained by the confidence interval");
	const splitClosureRoots = parseSplitClosureRoots(item.splitClosureRoots, `${label}.splitClosureRoots`);
	const parsed: AutoResearchPortfolioMeasurement = {
		measurementId: identifier(item.measurementId, `${label}.measurementId`),
		goalId: identifier(item.goalId, `${label}.goalId`),
		candidateId: item.candidateId === null ? null : identifier(item.candidateId, `${label}.candidateId`),
		scope: scope(item.scope, `${label}.scope`),
		kind: item.kind,
		vector: sortedArray(vector, (left, right) => left.metricId.localeCompare(right.metricId)),
		repeatIndex: boundedInteger(item.repeatIndex, `${label}.repeatIndex`, MAX_ARRAY_ENTRIES),
		sampleCount,
		evaluationEpoch: positiveInteger(item.evaluationEpoch, `${label}.evaluationEpoch`),
		inputManifestDigest,
		splitClosureRoots,
		confidenceInterval,
		variance: nonNegativeNumber(item.variance, `${label}.variance`),
		runCount,
		aggregation: item.aggregation,
		inputDigest,
		evaluatorDigest: digest(item.evaluatorDigest, `${label}.evaluatorDigest`),
		parserDigest: digest(item.parserDigest, `${label}.parserDigest`),
		commandDigest: digest(item.commandDigest, `${label}.commandDigest`),
		workspaceDigest: digest(item.workspaceDigest, `${label}.workspaceDigest`),
		evidenceDigests: sortedStrings(evidenceDigests),
		measuredAt: isoTimestamp(item.measuredAt, `${label}.measuredAt`),
		measurementDigest: digest(item.measurementDigest, `${label}.measurementDigest`),
	};
	if (context !== undefined) validateMeasurementBinding(parsed, context, label);
	if (parsed.measurementDigest !== digestWithoutField(parsed, "measurementDigest"))
		fail(`${label}.measurementDigest`, "must equal the canonical measurement digest");
	return parsed;
}

function sortedRecords<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
	return sortedArray(values, (left, right) => key(left).localeCompare(key(right)));
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function normalizeContract(value: AutoResearchPortfolioContract): AutoResearchPortfolioContract {
	const goals = sortedRecords(
		arrayMap(value.goals, (entry) => ({
			...entry,
			metrics: sortedRecords(entry.metrics, (metricEntry) => metricEntry.metricId),
			baseline: {
				...entry.baseline,
				metricValues: sortedRecords(entry.baseline.metricValues, (metricEntry) => metricEntry.metricId),
			},
			parser: { ...entry.parser, metricKeys: sortedStrings(entry.parser.metricKeys) },
			falsification: { ...entry.falsification, criteria: sortedStrings(entry.falsification.criteria) },
			adversarial: { ...entry.adversarial, checks: sortedStrings(entry.adversarial.checks) },
		})),
		(entry) => entry.goalId,
	);
	const inputManifest: AutoResearchPortfolioInputManifest = {
		...value.inputManifest,
		training: {
			...value.inputManifest.training,
			artifacts: sortedRecords(value.inputManifest.training.artifacts, (entry) => entry.objectUri),
		},
		validation: {
			...value.inputManifest.validation,
			artifacts: sortedRecords(value.inputManifest.validation.artifacts, (entry) => entry.objectUri),
		},
		holdout: {
			...value.inputManifest.holdout,
			artifacts: sortedRecords(value.inputManifest.holdout.artifacts, (entry) => entry.objectUri),
		},
	};
	return {
		...value,
		inputManifest,
		acceptanceRequirements: sortedRecords(value.acceptanceRequirements, (entry) => entry.requirementId),
		goals,
		goalRelations: sortedRecords(
			value.goalRelations,
			(entry) => `${entry.fromGoalId}\u0000${entry.toGoalId}\u0000${entry.relation}\u0000${entry.rationale}`,
		),
		lexicographicTiers: sortedRecords(
			arrayMap(value.lexicographicTiers, (entry) => ({ ...entry, goalIds: sortedStrings(entry.goalIds) })),
			(entry) => String(entry.tier),
		),
		hardBoundaries: sortedRecords(value.hardBoundaries, (entry) => entry.boundaryId),
		invariants: sortedRecords(value.invariants, (entry) => entry.invariantId),
		nonGoals: sortedRecords(value.nonGoals, (entry) => entry.nonGoalId),
		scopePartitions: sortedRecords(
			arrayMap(value.scopePartitions, (entry) => ({
				...entry,
				paths: sortedStrings(entry.paths),
				dataDigests: sortedStrings(entry.dataDigests),
			})),
			(entry) => entry.partitionId,
		),
	};
}

function validateCrossReferences(value: AutoResearchPortfolioContract): void {
	const inputManifest = value.inputManifest;
	const expectedEpoch = inputManifest.evaluationEpoch;
	const expectedManifestRevision = inputManifest.manifestRevision;
	const expectedClosureRootDigest = inputManifest.closureRootDigest;
	const expectedManifestDigest = inputManifest.manifestDigest;
	const goalIds = arrayMap(value.goals, (entry) => entry.goalId);
	ensureUnique(goalIds, "goals");
	const goalIdSet = new Set(goalIds);
	const requirementIds = arrayMap(value.acceptanceRequirements, (entry) => entry.requirementId);
	ensureUnique(requirementIds, "acceptanceRequirements");
	const requirementIdSet = new Set(requirementIds);
	const coveredRequirementIds = new Set<string>();
	ensureUnique(
		arrayFlatMap(value.goals, (entry) => arrayMap(entry.metrics, (metricEntry) => metricEntry.metricId)),
		"goals.metrics",
	);
	const relationKeys = new Set<string>();
	const relationKinds = new Map<string, AutoResearchPortfolioGoalRelationKind>();
	const prerequisiteEdges = new Map<string, string[]>();
	for (const relation of value.goalRelations) {
		if (
			!goalIdSet.has(relation.fromGoalId) ||
			!goalIdSet.has(relation.toGoalId) ||
			relation.fromGoalId === relation.toGoalId
		)
			fail("goalRelations", "must reference two distinct declared goals");
		const relationPairKey = `${relation.fromGoalId}\u0000${relation.toGoalId}`;
		if (relationKeys.has(relationPairKey))
			fail("goalRelations", "a directed goal pair cannot carry contradictory simultaneous relations");
		relationKeys.add(relationPairKey);
		relationKinds.set(relationPairKey, relation.relation);
		if (relation.relation === "prerequisite") {
			const outgoing = prerequisiteEdges.get(relation.fromGoalId) ?? [];
			outgoing.push(relation.toGoalId);
			prerequisiteEdges.set(relation.fromGoalId, outgoing);
		}
	}
	for (const relation of value.goalRelations) {
		const reverseRelation = relationKinds.get(`${relation.toGoalId}\u0000${relation.fromGoalId}`);
		const relationIsDependency = relation.relation === "prerequisite" || relation.relation === "complementary";
		const relationIsTradeoff = relation.relation === "competing" || relation.relation === "conflict";
		const reverseIsDependency = reverseRelation === "prerequisite" || reverseRelation === "complementary";
		const reverseIsTradeoff = reverseRelation === "competing" || reverseRelation === "conflict";
		if (
			reverseRelation !== undefined &&
			((relationIsDependency && reverseIsTradeoff) || (relationIsTradeoff && reverseIsDependency))
		)
			fail("goalRelations", "reverse dependency and tradeoff relations are contradictory");
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visitPrerequisites = (goalId: string): void => {
		if (visiting.has(goalId)) fail("goalRelations", "prerequisite cycle is not admissible");
		if (visited.has(goalId)) return;
		visiting.add(goalId);
		for (const nextGoalId of prerequisiteEdges.get(goalId) ?? []) visitPrerequisites(nextGoalId);
		visiting.delete(goalId);
		visited.add(goalId);
	};
	for (const goalId of goalIds) visitPrerequisites(goalId);
	const tierNumbers = arrayMap(value.lexicographicTiers, (entry) => entry.tier);
	ensureUnique(arrayMap(tierNumbers, String), "lexicographicTiers");
	const sortedTiers = sortedArray(tierNumbers, (left, right) => left - right);
	if (arraySome(sortedTiers, (entry, index) => entry !== index + 1))
		fail("lexicographicTiers", "tiers must be contiguous starting at 1");
	const tierGoalIds = arrayFlatMap(value.lexicographicTiers, (entry) => entry.goalIds);
	ensureUnique(tierGoalIds, "lexicographicTiers.goalIds");
	if (arraySome(tierGoalIds, (entry) => !goalIdSet.has(entry)) || tierGoalIds.length !== goalIds.length)
		fail("lexicographicTiers", "must cover every declared goal exactly once");
	const tierByGoalId = new Map<string, number>();
	for (const tier of value.lexicographicTiers) {
		for (const goalId of tier.goalIds) tierByGoalId.set(goalId, tier.tier);
	}
	for (const relation of value.goalRelations) {
		const fromTier = tierByGoalId.get(relation.fromGoalId);
		const toTier = tierByGoalId.get(relation.toGoalId);
		if (fromTier === undefined || toTier === undefined) fail("lexicographicTiers", "must cover related goals");
		if (relation.relation === "prerequisite" && fromTier >= toTier)
			fail("lexicographicTiers", "prerequisite goals must precede their dependent goal");
	}
	ensureUnique(
		arrayMap(value.scopePartitions, (entry) => entry.partitionId),
		"scopePartitions",
	);
	ensureUnique(
		arrayMap(value.invariants, (entry) => entry.invariantId),
		"invariants",
	);
	ensureUnique(
		arrayMap(value.hardBoundaries, (entry) => entry.boundaryId),
		"hardBoundaries",
	);
	ensureUnique(
		arrayMap(value.nonGoals, (entry) => entry.nonGoalId),
		"nonGoals",
	);
	for (const goal of value.goals) {
		for (const metric of goal.metrics) {
			if (!requirementIdSet.has(metric.requirementId))
				fail("goals.metrics.requirementId", "must reference a declared immutable acceptance requirement");
			coveredRequirementIds.add(metric.requirementId);
			if (metric.evaluationEpoch !== expectedEpoch || metric.metricRevision > expectedEpoch)
				fail("goals.metrics", "metric revisions must bind the fresh evaluation epoch");
			if (metric.closureRootDigest !== expectedClosureRootDigest)
				fail("goals.metrics", "metric closure root does not match the immutable input manifest");
			if (metric.inputManifestDigest !== expectedManifestDigest)
				fail("goals.metrics", "metric input manifest binding does not match the immutable manifest");
			if (!sameSplitClosureRoots(metric.splitClosureRoots, inputManifest.splitClosureRoots))
				fail("goals.metrics", "metric split closure roots do not match the immutable input manifest");
		}
		if (
			goal.baseline.evaluationEpoch !== expectedEpoch ||
			goal.evaluator.evaluationEpoch !== expectedEpoch ||
			goal.parser.evaluationEpoch !== expectedEpoch ||
			goal.opaqueHoldout.evaluationEpoch !== expectedEpoch
		)
			fail("goals", "evaluation manifests must bind the fresh evaluation epoch");
		if (
			goal.evaluator.evaluatorRevision > expectedEpoch ||
			goal.parser.inputManifestRevision !== expectedManifestRevision ||
			goal.parser.inputManifestRevision > expectedEpoch
		)
			fail("goals", "evaluator and parser revisions must bind the fresh input-manifest epoch");
		for (const [label, closureRootDigest] of [
			["baseline", goal.baseline.closureRootDigest],
			["evaluator", goal.evaluator.closureRootDigest],
			["parser", goal.parser.closureRootDigest],
			["opaqueHoldout", goal.opaqueHoldout.closureRootDigest],
		] as const) {
			if (closureRootDigest !== expectedClosureRootDigest)
				fail(`goals.${label}`, "closure root does not match the immutable input manifest");
		}
		for (const [label, splitClosureRoots] of [
			["baseline", goal.baseline.splitClosureRoots],
			["evaluator", goal.evaluator.splitClosureRoots],
			["parser", goal.parser.splitClosureRoots],
			["opaqueHoldout", goal.opaqueHoldout.splitClosureRoots],
		] as const) {
			if (!sameSplitClosureRoots(splitClosureRoots, inputManifest.splitClosureRoots))
				fail(`goals.${label}`, "split closure roots do not match the immutable input manifest");
		}
		for (const [label, manifestDigest] of [
			["baseline", goal.baseline.inputManifestDigest],
			["evaluator", goal.evaluator.inputManifestDigest],
			["parser", goal.parser.inputManifestDigest],
		] as const) {
			if (manifestDigest !== expectedManifestDigest)
				fail(`goals.${label}`, "input manifest binding does not match the immutable manifest");
		}
	}
	if (coveredRequirementIds.size !== requirementIdSet.size)
		fail("acceptanceRequirements", "every required umbrella acceptance check must be covered by a metric");
}

function parseLegacyOrActiveRecord(value: unknown): Record<string, unknown> {
	const item = record(value, "contract");
	if (item.kind === "read_only_provenance")
		fail("provenance", "read-only provenance cannot be parsed as an active portfolio");
	if (item.schemaVersion === 2 || ("metric" in item && "target" in item) || ("goal" in item && !("goals" in item)))
		fail(
			"incompatible_migration",
			"legacy scalar schema is read-only; migrate to schemaVersion 3 vector portfolio contracts",
		);
	return item;
}

/** Parse one closed schema-v3 AutoResearch portfolio and return a deeply frozen canonical record. */
export function parseAutoResearchPortfolioContract(value: unknown): AutoResearchPortfolioContract {
	const item = parseLegacyOrActiveRecord(value);
	exactKeys(
		item,
		[
			"schemaVersion",
			"contractId",
			"objective",
			"acceptanceRequirements",
			"goals",
			"goalRelations",
			"lexicographicTiers",
			"hardBoundaries",
			"invariants",
			"nonGoals",
			"budgets",
			"safety",
			"inputManifest",
			"scopePartitions",
			"terminalScope",
			"learningScope",
		],
		"contract",
	);
	if (item.schemaVersion !== AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION) fail("schema", "only schemaVersion 3 is active");
	if (item.terminalScope !== "terminal" || item.learningScope !== "learning")
		fail("scope", "terminalScope and learningScope are fixed enums");
	const acceptanceRequirements = closedArray(item.acceptanceRequirements, "acceptanceRequirements");
	const goals = closedArray(item.goals, "goals");
	const goalRelations = closedArray(item.goalRelations, "goalRelations");
	const lexicographicTiers = closedArray(item.lexicographicTiers, "lexicographicTiers");
	const hardBoundaries = closedArray(item.hardBoundaries, "hardBoundaries");
	const invariants = closedArray(item.invariants, "invariants");
	const nonGoals = closedArray(item.nonGoals, "nonGoals");
	const scopePartitions = closedArray(item.scopePartitions, "scopePartitions");
	if (acceptanceRequirements.length === 0) fail("acceptanceRequirements", "must be a bounded non-empty list");
	if (goals.length === 0) fail("goals", "must be a bounded non-empty list");
	if (lexicographicTiers.length === 0) fail("lexicographicTiers", "must be a bounded non-empty list");
	if (hardBoundaries.length === 0) fail("hardBoundaries", "must be a bounded non-empty list");
	if (invariants.length === 0) fail("invariants", "must be a bounded non-empty list");
	if (scopePartitions.length === 0) fail("scopePartitions", "must be a bounded non-empty list");
	const parsed: AutoResearchPortfolioContract = {
		schemaVersion: AUTO_RESEARCH_PORTFOLIO_SCHEMA_VERSION,
		contractId: identifier(item.contractId, "contract.contractId"),
		objective: text(item.objective, "contract.objective"),
		acceptanceRequirements: arrayMap(acceptanceRequirements, (entry, index) =>
			parseAcceptanceRequirement(entry, `contract.acceptanceRequirements[${index}]`),
		),
		goals: arrayMap(goals, (entry, index) => parseGoal(entry, `contract.goals[${index}]`)),
		goalRelations: arrayMap(goalRelations, (entry, index) =>
			parseRelation(entry, `contract.goalRelations[${index}]`),
		),
		lexicographicTiers: arrayMap(lexicographicTiers, (entry, index) =>
			parseTier(entry, `contract.lexicographicTiers[${index}]`),
		),
		hardBoundaries: arrayMap(hardBoundaries, (entry, index) =>
			parseBoundary(entry, `contract.hardBoundaries[${index}]`),
		),
		invariants: arrayMap(invariants, (entry, index) => parseInvariant(entry, `contract.invariants[${index}]`)),
		nonGoals: arrayMap(nonGoals, (entry, index) => parseNonGoal(entry, `contract.nonGoals[${index}]`)),
		budgets: parseBudgets(item.budgets, "contract.budgets"),
		safety: parseSafety(item.safety, "contract.safety"),
		inputManifest: parseInputManifest(item.inputManifest, "contract.inputManifest"),
		scopePartitions: arrayMap(scopePartitions, (entry, index) =>
			parseScopePartition(entry, `contract.scopePartitions[${index}]`),
		),
		terminalScope: "terminal",
		learningScope: "learning",
	};
	validateCrossReferences(parsed);
	const frozen = deepFreeze(normalizeContract(parsed));
	PARSED_CONTRACTS.add(frozen);
	return frozen;
}

/** Parse one standalone closed schema-v3 candidate. */
export function parseAutoResearchPortfolioCandidate(value: unknown): AutoResearchPortfolioCandidate {
	const frozen = deepFreeze(parseCandidate(value, "candidate"));
	PARSED_CANDIDATES.add(frozen);
	return frozen;
}

/** Project a training-only payload; production worker isolation remains an integration responsibility. */
export function projectAutoResearchPortfolioTrainingProjection(
	contract: AutoResearchPortfolioContract,
): AutoResearchPortfolioTrainingProjection {
	return deepFreeze({
		split: "training",
		manifestDigest: contract.inputManifest.manifestDigest,
		closureRootDigest: contract.inputManifest.training.closureRootDigest,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		artifacts: arrayMap(contract.inputManifest.training.artifacts, (artifact) => ({
			objectUri: artifact.objectUri,
			generation: artifact.generation,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
			schemaVersion: artifact.schemaVersion,
			modality: artifact.modality,
			instrumentSet: arrayCopy(artifact.instrumentSet),
		})),
	});
}

/** Parse one standalone closed schema-v3 vector measurement. */
export function parseAutoResearchPortfolioMeasurement(
	value: unknown,
	context?: AutoResearchPortfolioMeasurementBindingContext,
): AutoResearchPortfolioMeasurement {
	const frozen = deepFreeze(parseMeasurement(value, "measurement", context));
	PARSED_MEASUREMENTS.add(frozen);
	return frozen;
}

/** Validate a parsed host measurement against the goal and immutable input bindings. */
export function validateAutoResearchPortfolioMeasurementBinding(
	measurement: AutoResearchPortfolioMeasurement,
	context: AutoResearchPortfolioMeasurementBindingContext,
): void {
	validateMeasurementBinding(measurement, context, "measurement");
}

/** Compute the canonical digest of one strict schema-v3 portfolio. */
export function autoResearchPortfolioContractDigest(value: unknown): string {
	if (typeof value === "object" && value !== null && PARSED_CONTRACTS.has(value)) return safeDigestObject(value);
	return safeDigestObject(parseAutoResearchPortfolioContract(value));
}

/** Compute the canonical digest of one strict standalone candidate. */
export function autoResearchPortfolioCandidateDigest(value: unknown): string {
	if (typeof value === "object" && value !== null && PARSED_CANDIDATES.has(value)) return safeDigestObject(value);
	const parsed = parseAutoResearchPortfolioCandidate(value);
	return safeDigestObject({
		...parsed,
		goalIds: sortedStrings(parsed.goalIds),
		ancestry: { ...parsed.ancestry, parentCandidateIds: sortedStrings(parsed.ancestry.parentCandidateIds) },
		change: {
			...parsed.change,
			changedPaths: sortedStrings(parsed.change.changedPaths),
			parameterChanges: sortedStrings(parsed.change.parameterChanges),
		},
	});
}

/** Compute the canonical digest of one strict standalone vector measurement. */
export function autoResearchPortfolioMeasurementDigest(value: unknown): string {
	if (typeof value === "object" && value !== null && PARSED_MEASUREMENTS.has(value)) return safeDigestObject(value);
	const parsed = parseAutoResearchPortfolioMeasurement(value);
	return safeDigestObject({
		...parsed,
		vector: sortedRecords(parsed.vector, (entry) => entry.metricId),
		evidenceDigests: sortedStrings(parsed.evidenceDigests),
	});
}
