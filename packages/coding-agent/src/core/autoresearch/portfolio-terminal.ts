import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptCapabilityBinding,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type {
	AutoResearchPortfolioContract,
	AutoResearchPortfolioDatasetCoverage,
	AutoResearchPortfolioMeasurement,
	AutoResearchPortfolioSplitClosureRoots,
} from "./portfolio-contracts.js";
import { parseAutoResearchPortfolioContract, parseAutoResearchPortfolioMeasurement } from "./portfolio-contracts.js";

export const PORTFOLIO_GOAL_DISPOSITIONS = Object.freeze([
	"active",
	"achieved",
	"regressed",
	"blocked",
	"budget_limited",
	"search_exhausted",
	"infeasible",
	"withdrawn_by_user",
] as const);

export type PortfolioGoalDisposition = (typeof PORTFOLIO_GOAL_DISPOSITIONS)[number];

export const PORTFOLIO_TERMINAL_OUTCOMES = Object.freeze([
	"complete",
	"complete_with_tradeoff",
	"partial_success",
	"infeasible",
	"search_exhausted",
	"stopped",
	"failed",
	"boundary_violation",
] as const);

export type PortfolioTerminalOutcome = (typeof PORTFOLIO_TERMINAL_OUTCOMES)[number];

export const PORTFOLIO_TERMINAL_CAPABILITY_ROLES = Object.freeze([
	"frontier",
	"boundary",
	"acquisition",
	"completion",
	"measurement",
	"goal_decision",
	"tradeoff",
	"infeasibility_evaluator",
	"infeasibility_adjudicator",
	"stop",
] as const);

export type PortfolioTerminalCapabilityRole = (typeof PORTFOLIO_TERMINAL_CAPABILITY_ROLES)[number];

export interface PortfolioTerminalCommitIntent {
	readonly capability: "portfolio_default_completion";
	readonly outcome: PortfolioTerminalOutcome;
	readonly receiptIds: readonly string[];
	readonly bindingDigests: readonly string[];
	readonly resourceDigests: readonly string[];
	readonly operationDigests: readonly string[];
	readonly workflowId: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly evaluationEpoch: number;
	readonly witnessRequired: true;
}

export interface PortfolioHostMeasurementEvidence {
	readonly measurement: AutoResearchPortfolioMeasurement;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostFrontierEntry {
	readonly entryId: string;
	readonly candidateId: string;
	readonly domainId: string;
	readonly goalIds: readonly string[];
}

export interface PortfolioHostFrontierEvidence {
	readonly entries: readonly PortfolioHostFrontierEntry[];
	readonly selectedEntryIds: readonly string[];
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostBoundaryEvidence {
	readonly boundaryId: string;
	readonly passed: boolean;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostArtifactEvidence {
	readonly split: "training" | "validation" | "holdout";
	readonly objectUri: string;
	readonly generation: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly closureRootDigest: string;
	readonly coverage: AutoResearchPortfolioDatasetCoverage;
	readonly gapClassification: "none" | "provider_empty" | "partial_coverage" | "unknown" | "missing";
	readonly lifecycle: "in_progress" | "sealed" | "superseded" | "quarantined";
	readonly independentlyRestored: boolean;
	readonly independentlyRehashed: boolean;
	readonly verificationEvidenceDigest: string | null;
}

export interface PortfolioHostAcquisitionSplitEvidence {
	readonly split: "training" | "validation" | "holdout";
	readonly artifacts: readonly PortfolioHostArtifactEvidence[];
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostAcquisitionEvidence {
	readonly splits: readonly PortfolioHostAcquisitionSplitEvidence[];
}

export interface PortfolioHostCompletionEvidence {
	readonly manifestGeneration: number;
	readonly manifestRevision: number;
	readonly manifestDigest: string;
	readonly closureRootDigest: string;
	readonly artifacts: readonly PortfolioHostArtifactEvidence[];
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioTradeoffFloor {
	readonly goalId: string;
	readonly value: number;
}

export interface PortfolioHostTradeoffBody {
	readonly concessions: readonly string[];
	readonly floors: readonly PortfolioTradeoffFloor[];
	readonly evidenceIds: readonly string[];
	readonly selectedFrontierEntryIds: readonly string[];
}

export interface PortfolioHostTradeoffEvidence extends PortfolioHostTradeoffBody {
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostInfeasibilityEvidence {
	readonly goalId: string;
	readonly evaluatorProofDigest: string;
	readonly adjudicationDigest: string;
	readonly evaluatorProofReceipt: WorkflowVerifiedHostReceipt;
	readonly adjudicationReceipt: WorkflowVerifiedHostReceipt;
}

export type PortfolioHostGoalDecision = "blocked" | "budget_limited" | "search_exhausted" | "withdrawn_by_user";
const PORTFOLIO_HOST_GOAL_DECISIONS: readonly PortfolioHostGoalDecision[] = [
	"blocked",
	"budget_limited",
	"search_exhausted",
	"withdrawn_by_user",
];

export interface PortfolioHostGoalDecisionEvidence {
	readonly goalId: string;
	readonly disposition: PortfolioHostGoalDecision;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioHostStopEvidence {
	readonly reason: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioTerminalInput {
	readonly contract: AutoResearchPortfolioContract;
	readonly workflowId: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly trustedNow: string;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly measurements: readonly PortfolioHostMeasurementEvidence[];
	readonly frontier: PortfolioHostFrontierEvidence;
	readonly boundaries: readonly PortfolioHostBoundaryEvidence[];
	readonly acquisition: PortfolioHostAcquisitionEvidence;
	readonly completion: PortfolioHostCompletionEvidence;
	readonly tradeoff: PortfolioHostTradeoffEvidence | null;
	readonly infeasibility: readonly PortfolioHostInfeasibilityEvidence[];
	readonly goalDecisions: readonly PortfolioHostGoalDecisionEvidence[];
	readonly stop: PortfolioHostStopEvidence | null;
}

export interface PortfolioGoalDispositionResult {
	readonly goalId: string;
	readonly disposition: PortfolioGoalDisposition;
}

export interface PortfolioTerminalEvaluation {
	readonly accepted: boolean;
	readonly outcome: PortfolioTerminalOutcome;
	readonly goalDispositions: readonly PortfolioGoalDispositionResult[];
	readonly requiredGoalIds: readonly string[];
	readonly unresolvedGoalIds: readonly string[];
	readonly selectedFrontierEntryIds: readonly string[];
	readonly reasons: readonly string[];
	readonly authority: "host";
	readonly workerCanAuthorize: false;
	readonly candidateCanAuthorize: false;
	readonly mutated: false;
	readonly commitIntent?: PortfolioTerminalCommitIntent | null;
	readonly evaluationDigest: string;
}

const PORTFOLIO_HOST_MEASUREMENT_EVIDENCE_KEYS = ["measurement", "receipt"] as const;
const PORTFOLIO_MEASUREMENT_KEYS = [
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
] as const;
const PORTFOLIO_TERMINAL_INPUT_KEYS = [
	"contract",
	"workflowId",
	"currentStateDigest",
	"currentRevision",
	"trustedNow",
	"receiptContext",
	"measurements",
	"frontier",
	"boundaries",
	"acquisition",
	"completion",
	"tradeoff",
	"infeasibility",
	"goalDecisions",
	"stop",
] as const;
const PORTFOLIO_FRONTIER_KEYS = ["entries", "selectedEntryIds", "receipt"] as const;
const PORTFOLIO_FRONTIER_ENTRY_KEYS = ["entryId", "candidateId", "domainId", "goalIds"] as const;
const PORTFOLIO_BOUNDARY_KEYS = ["boundaryId", "passed", "receipt"] as const;
const PORTFOLIO_ARTIFACT_KEYS = [
	"split",
	"objectUri",
	"generation",
	"sha256",
	"bytes",
	"closureRootDigest",
	"coverage",
	"gapClassification",
	"lifecycle",
	"independentlyRestored",
	"independentlyRehashed",
	"verificationEvidenceDigest",
] as const;
const PORTFOLIO_ACQUISITION_KEYS = ["splits"] as const;
const PORTFOLIO_ACQUISITION_SPLIT_KEYS = ["split", "artifacts", "receipt"] as const;
const PORTFOLIO_COMPLETION_KEYS = [
	"manifestGeneration",
	"manifestRevision",
	"manifestDigest",
	"closureRootDigest",
	"artifacts",
	"receipt",
] as const;
const PORTFOLIO_TRADEOFF_KEYS = [
	"concessions",
	"floors",
	"evidenceIds",
	"selectedFrontierEntryIds",
	"receipt",
] as const;
const PORTFOLIO_TRADEOFF_FLOOR_KEYS = ["goalId", "value"] as const;
const PORTFOLIO_INFEASIBILITY_KEYS = [
	"goalId",
	"evaluatorProofDigest",
	"adjudicationDigest",
	"evaluatorProofReceipt",
	"adjudicationReceipt",
] as const;
const PORTFOLIO_GOAL_DECISION_KEYS = ["goalId", "disposition", "receipt"] as const;
const PORTFOLIO_STOP_KEYS = ["reason", "receipt"] as const;
const WORKFLOW_RECEIPT_KEYS = [
	"receiptKind",
	"oneUse",
	"receiptId",
	"issuerId",
	"workflowId",
	"bindingDigest",
	"payloadDigest",
	"artifactRef",
	"issuedAt",
	"validUntil",
	"keyId",
	"signatureAlgorithm",
	"artifactBytesDigest",
	"stateDigest",
	"revision",
	"signature",
	"verificationDigest",
] as const;
const WORKFLOW_RECEIPT_KEYS_WITH_CAPABILITY = [...WORKFLOW_RECEIPT_KEYS, "capabilityBinding"] as const;
const WORKFLOW_CAPABILITY_BINDING_KEYS = [
	"capability",
	"resourceDigest",
	"operationDigest",
	"executionIdentity",
	"sessionId",
] as const;
const WORKFLOW_ARTIFACT_REF_KEYS = [
	"artifactId",
	"relativePath",
	"digest",
	"sizeBytes",
	"sourceEventSequence",
] as const;
const RECEIPT_KINDS = ["clock", "artifact", "capability", "decision", "lease", "usage", "adjudication"] as const;
const ARTIFACT_SPLITS = ["training", "validation", "holdout"] as const;
const ARTIFACT_COVERAGE = ["complete", "provider_empty", "partial_coverage", "unknown", "missing"] as const;
const ARTIFACT_GAPS = ["none", "provider_empty", "partial_coverage", "unknown", "missing"] as const;
const ARTIFACT_LIFECYCLES = ["in_progress", "sealed", "superseded", "quarantined"] as const;

interface PortfolioCompletionBinding {
	readonly manifestGeneration: number;
	readonly manifestRevision: number;
	readonly manifestDigest: string;
	readonly closureRootDigest: string;
	readonly artifacts: readonly PortfolioHostArtifactEvidence[];
}

function contractDigest(contract: AutoResearchPortfolioContract): string {
	return digestObject(contract);
}

function sortedStrings(values: readonly string[]): readonly string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function sameSplitClosureRoots(
	left: AutoResearchPortfolioSplitClosureRoots | null | undefined,
	right: AutoResearchPortfolioSplitClosureRoots | null | undefined,
): boolean {
	return (
		left !== null &&
		left !== undefined &&
		right !== null &&
		right !== undefined &&
		left.training === right.training &&
		left.validation === right.validation &&
		left.holdout === right.holdout
	);
}

function sameArtifacts(
	left: readonly PortfolioHostArtifactEvidence[],
	right: readonly {
		readonly split: "training" | "validation" | "holdout";
		readonly objectUri: string;
		readonly generation: number;
		readonly sha256: string;
		readonly bytes: number;
		readonly closureRootDigest: string;
		readonly coverage: AutoResearchPortfolioDatasetCoverage;
		readonly gapClassification: "none" | "provider_empty" | "partial_coverage" | "unknown" | "missing";
		readonly lifecycle: "in_progress" | "sealed" | "superseded" | "quarantined";
		readonly independentlyRestored: boolean;
		readonly independentlyRehashed: boolean;
		readonly verificationEvidenceDigest: string | null;
	}[],
): boolean {
	return JSON.stringify(canonicalArtifacts(left)) === JSON.stringify(canonicalArtifacts(right));
}

function sameAcquisitionArtifacts(
	left: readonly PortfolioHostArtifactEvidence[],
	right: readonly PortfolioHostArtifactEvidence[],
): boolean {
	if (left.length !== right.length) return false;
	const canonical = (artifacts: readonly PortfolioHostArtifactEvidence[]) =>
		canonicalArtifacts(artifacts).map((artifact) => ({
			split: artifact.split,
			objectUri: artifact.objectUri,
			generation: artifact.generation,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
			closureRootDigest: artifact.closureRootDigest,
			lifecycle: artifact.lifecycle,
			independentlyRestored: artifact.independentlyRestored,
			independentlyRehashed: artifact.independentlyRehashed,
			verificationEvidenceDigest: artifact.verificationEvidenceDigest,
		}));
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function isDigest(value: string): boolean {
	return /^[0-9a-f]{64}$/u.test(value);
}

function canonicalArtifacts(
	artifacts: readonly PortfolioHostArtifactEvidence[],
): readonly PortfolioHostArtifactEvidence[] {
	return [...artifacts].sort((left, right) =>
		`${left.split}\u0000${left.objectUri}\u0000${left.generation}\u0000${left.sha256}`.localeCompare(
			`${right.split}\u0000${right.objectUri}\u0000${right.generation}\u0000${right.sha256}`,
		),
	);
}

function manifestArtifacts(contract: AutoResearchPortfolioContract): readonly {
	readonly split: "training" | "validation" | "holdout";
	readonly objectUri: string;
	readonly generation: number;
	readonly sha256: string;
	readonly bytes: number;
	readonly closureRootDigest: string;
	readonly coverage: AutoResearchPortfolioDatasetCoverage;
	readonly gapClassification: "none" | "provider_empty" | "partial_coverage" | "unknown" | "missing";
	readonly lifecycle: "in_progress" | "sealed" | "superseded" | "quarantined";
	readonly independentlyRestored: boolean;
	readonly independentlyRehashed: boolean;
	readonly verificationEvidenceDigest: string | null;
}[] {
	const manifest = contract.inputManifest;
	const splitManifests = [manifest.training, manifest.validation, manifest.holdout];
	return splitManifests.flatMap((splitManifest) =>
		splitManifest.artifacts.map((artifact) => ({
			split: artifact.split,
			objectUri: artifact.objectUri,
			generation: artifact.generation,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
			closureRootDigest: artifact.closureRootDigest,
			coverage: artifact.coverage,
			gapClassification: artifact.gapClassification,
			lifecycle: artifact.lifecycle,
			independentlyRestored: artifact.restoreVerification.independentlyRestored,
			independentlyRehashed: artifact.restoreVerification.independentlyRehashed,
			verificationEvidenceDigest: artifact.restoreVerification.verificationEvidenceDigest,
		})),
	);
}

function bindingDigest(kind: string, contract: AutoResearchPortfolioContract, payload: object): string {
	return digestObject({ kind, contractDigest: contractDigest(contract), payload });
}

export function portfolioMeasurementBindingDigest(
	contract: AutoResearchPortfolioContract,
	measurement: AutoResearchPortfolioMeasurement,
): string {
	const goal = contract.goals.find((entry) => entry.goalId === measurement.goalId);
	if (goal === undefined) throw new Error("portfolio measurement goal is not in the contract");
	return bindingDigest("portfolio.measurement.v1", contract, {
		measurementId: measurement.measurementId,
		goalId: measurement.goalId,
		domainId: goal.domainId,
		candidateId: measurement.candidateId,
		kind: measurement.kind,
		repeatIndex: measurement.repeatIndex,
		sampleCount: measurement.sampleCount,
		inputDigest: measurement.inputDigest,
		inputManifestDigest: measurement.inputManifestDigest,
		evaluatorDigest: measurement.evaluatorDigest,
		parserDigest: measurement.parserDigest,
		commandDigest: measurement.commandDigest,
		workspaceDigest: measurement.workspaceDigest,
		evidenceDigests: measurement.evidenceDigests,
		measuredAt: measurement.measuredAt,
		measurementDigest: measurement.measurementDigest,
		vector: measurement.vector,
		evaluationEpoch: measurement.evaluationEpoch,
		closureRootDigest: contract.inputManifest.closureRootDigest,
		splitClosureRoots: measurement.splitClosureRoots,
		confidenceInterval: measurement.confidenceInterval,
		variance: measurement.variance,
		runCount: measurement.runCount,
		aggregation: measurement.aggregation,
	});
}

export function portfolioFrontierBindingDigest(
	contract: AutoResearchPortfolioContract,
	entries: readonly PortfolioHostFrontierEntry[],
	selectedEntryIds: readonly string[],
): string {
	return bindingDigest("portfolio.frontier.v1", contract, {
		entries: [...entries]
			.map((entry) => ({ ...entry, goalIds: sortedStrings(entry.goalIds) }))
			.sort((left, right) => left.entryId.localeCompare(right.entryId)),
		selectedEntryIds: sortedStrings(selectedEntryIds),
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		closureRootDigest: contract.inputManifest.closureRootDigest,
	});
}

export function portfolioBoundaryBindingDigest(
	contract: AutoResearchPortfolioContract,
	boundaryId: string,
	passed: boolean,
): string {
	return bindingDigest("portfolio.boundary.v1", contract, {
		boundaryId,
		passed,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		closureRootDigest: contract.inputManifest.closureRootDigest,
	});
}

export function portfolioAcquisitionBindingDigest(
	contract: AutoResearchPortfolioContract,
	split: "training" | "validation" | "holdout",
	artifacts: readonly PortfolioHostArtifactEvidence[],
): string {
	return bindingDigest("portfolio.acquisition.v1", contract, {
		split,
		artifacts: canonicalArtifacts(artifacts),
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
	});
}

export function portfolioCompletionBindingDigest(
	contract: AutoResearchPortfolioContract,
	binding: PortfolioCompletionBinding,
): string {
	return bindingDigest("portfolio.completion.v1", contract, {
		manifestGeneration: binding.manifestGeneration,
		manifestRevision: binding.manifestRevision,
		manifestDigest: binding.manifestDigest,
		closureRootDigest: binding.closureRootDigest,
		artifacts: canonicalArtifacts(binding.artifacts),
	});
}

export function portfolioTradeoffBindingDigest(
	contract: AutoResearchPortfolioContract,
	body: PortfolioHostTradeoffBody,
): string {
	return bindingDigest("portfolio.tradeoff.v1", contract, {
		concessions: sortedStrings(body.concessions),
		floors: [...body.floors].sort((left, right) => left.goalId.localeCompare(right.goalId)),
		evidenceIds: sortedStrings(body.evidenceIds),
		selectedFrontierEntryIds: sortedStrings(body.selectedFrontierEntryIds),
	});
}

export function portfolioInfeasibilityProofBindingDigest(
	contract: AutoResearchPortfolioContract,
	goalId: string,
	proofDigest: string,
): string {
	return bindingDigest("portfolio.infeasibility-proof.v1", contract, { goalId, proofDigest });
}

export function portfolioInfeasibilityAdjudicationBindingDigest(
	contract: AutoResearchPortfolioContract,
	goalId: string,
	proofDigest: string,
	adjudicationDigest: string,
): string {
	return bindingDigest("portfolio.infeasibility-adjudication.v1", contract, {
		goalId,
		proofDigest,
		adjudicationDigest,
	});
}

export function portfolioGoalDecisionBindingDigest(
	contract: AutoResearchPortfolioContract,
	goalId: string,
	disposition: PortfolioHostGoalDecision,
): string {
	return bindingDigest("portfolio.goal-decision.v1", contract, { goalId, disposition });
}

export function portfolioStopBindingDigest(contract: AutoResearchPortfolioContract, reason: string): string {
	return bindingDigest("portfolio.stop.v1", contract, { reason });
}

function terminalCapabilityResourcePayload(
	contract: AutoResearchPortfolioContract,
	input: PortfolioTerminalInput,
	measurements: readonly AutoResearchPortfolioMeasurement[],
): object {
	return {
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		manifestRevision: contract.inputManifest.manifestRevision,
		manifestDigest: contract.inputManifest.manifestDigest,
		closureRootDigest: contract.inputManifest.closureRootDigest,
		splitClosureRoots: contract.inputManifest.splitClosureRoots,
		goals: contract.goals
			.filter((goal) => goal.scope === "terminal")
			.map((goal) => ({
				goalId: goal.goalId,
				domainId: goal.domainId,
				metrics: goal.metrics.map((metric) => ({
					metricId: metric.metricId,
					direction: metric.direction,
					target: metric.target,
					unit: metric.unit,
				})),
				baseline: {
					measurementId: goal.baseline.measurementId,
					metricValues: goal.baseline.metricValues,
					evidenceDigest: goal.baseline.evidenceDigest,
				},
				evaluatorDigest: goal.evaluator.evaluatorDigest,
				parserDigest: goal.parser.parserDigest,
				commandDigest: goal.command.commandDigest,
				repeatability: goal.repeatability,
				uncertainty: goal.uncertainty,
			}))
			.sort((left, right) => left.goalId.localeCompare(right.goalId)),
		frontier: {
			entries: input.frontier.entries
				.map((entry) => ({ ...entry, goalIds: sortedStrings(entry.goalIds) }))
				.sort((left, right) => left.entryId.localeCompare(right.entryId)),
			selectedEntryIds: sortedStrings(input.frontier.selectedEntryIds),
		},
		measurements: measurements
			.map((measurement) => ({
				measurementId: measurement.measurementId,
				goalId: measurement.goalId,
				candidateId: measurement.candidateId,
				kind: measurement.kind,
				vector: [...measurement.vector].sort((left, right) => left.metricId.localeCompare(right.metricId)),
				measurementDigest: measurement.measurementDigest,
				inputManifestDigest: measurement.inputManifestDigest,
				evaluationEpoch: measurement.evaluationEpoch,
				splitClosureRoots: measurement.splitClosureRoots,
				runCount: measurement.runCount,
				aggregation: measurement.aggregation,
				variance: measurement.variance,
				confidenceInterval: measurement.confidenceInterval,
			}))
			.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
		boundaries: input.boundaries
			.map((boundary) => ({ boundaryId: boundary.boundaryId, passed: boundary.passed }))
			.sort((left, right) => left.boundaryId.localeCompare(right.boundaryId)),
		acquisition: input.acquisition.splits
			.map((split) => ({ split: split.split, artifacts: canonicalArtifacts(split.artifacts) }))
			.sort((left, right) => left.split.localeCompare(right.split)),
		completion: {
			manifestGeneration: input.completion.manifestGeneration,
			manifestRevision: input.completion.manifestRevision,
			manifestDigest: input.completion.manifestDigest,
			closureRootDigest: input.completion.closureRootDigest,
			artifacts: canonicalArtifacts(input.completion.artifacts),
		},
		goalDecisions: input.goalDecisions
			.map((decision) => ({ goalId: decision.goalId, disposition: decision.disposition }))
			.sort((left, right) => left.goalId.localeCompare(right.goalId)),
		tradeoff:
			input.tradeoff === null
				? null
				: {
						concessions: sortedStrings(input.tradeoff.concessions),
						floors: [...input.tradeoff.floors].sort((left, right) => left.goalId.localeCompare(right.goalId)),
						evidenceIds: sortedStrings(input.tradeoff.evidenceIds),
						selectedFrontierEntryIds: sortedStrings(input.tradeoff.selectedFrontierEntryIds),
					},
		infeasibility: input.infeasibility
			.map((proof) => ({
				goalId: proof.goalId,
				evaluatorProofDigest: proof.evaluatorProofDigest,
				adjudicationDigest: proof.adjudicationDigest,
			}))
			.sort((left, right) => left.goalId.localeCompare(right.goalId)),
		stop: input.stop === null ? null : { reason: input.stop.reason },
	};
}

export function portfolioDefaultCompletionResourceDigest(
	contract: AutoResearchPortfolioContract,
	input: PortfolioTerminalInput,
	measurements: readonly AutoResearchPortfolioMeasurement[],
): string {
	return digestObject({
		kind: "portfolio.default_completion.resource.v1",
		contractDigest: contractDigest(contract),
		resource: terminalCapabilityResourcePayload(contract, input, measurements),
	});
}

export function portfolioDefaultCompletionOperationDigest(
	contract: AutoResearchPortfolioContract,
	input: PortfolioTerminalInput,
	measurements: readonly AutoResearchPortfolioMeasurement[],
	role: PortfolioTerminalCapabilityRole,
	bindingDigest: string,
): string {
	const resourceDigest = portfolioDefaultCompletionResourceDigest(contract, input, measurements);
	return digestObject({
		kind: "portfolio.default_completion.operation.v1",
		capability: "portfolio_default_completion",
		role,
		bindingDigest,
		resourceDigest,
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
	});
}

function commitIntentFor(
	input: PortfolioTerminalInput,
	contract: AutoResearchPortfolioContract,
	outcome: PortfolioTerminalOutcome,
): PortfolioTerminalCommitIntent | null {
	const receipts: WorkflowVerifiedHostReceipt[] = [
		input.frontier.receipt,
		...input.boundaries.map((entry) => entry.receipt),
		...input.acquisition.splits.map((entry) => entry.receipt),
		input.completion.receipt,
		...input.measurements.map((entry) => entry.receipt),
		...(input.tradeoff === null ? [] : [input.tradeoff.receipt]),
		...input.infeasibility.flatMap((entry) => [entry.evaluatorProofReceipt, entry.adjudicationReceipt]),
		...input.goalDecisions.map((entry) => entry.receipt),
		...(input.stop === null ? [] : [input.stop.receipt]),
	];
	const oneUse = [
		...new Map(receipts.filter((receipt) => receipt.oneUse).map((receipt) => [receipt.receiptId, receipt])).values(),
	].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
	if (oneUse.length === 0) return null;
	if (oneUse.some((receipt) => !isHostCapabilityReceipt(receipt))) return null;
	return {
		capability: "portfolio_default_completion",
		outcome,
		receiptIds: oneUse.map((receipt) => receipt.receiptId),
		bindingDigests: oneUse.map((receipt) => receipt.bindingDigest),
		resourceDigests: oneUse.map((receipt) => receipt.capabilityBinding!.resourceDigest),
		operationDigests: oneUse.map((receipt) => receipt.capabilityBinding!.operationDigest),
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		evaluationEpoch: contract.inputManifest.evaluationEpoch,
		witnessRequired: true,
	};
}

function output(
	contract: AutoResearchPortfolioContract,
	outcome: PortfolioTerminalOutcome,
	goalDispositions: readonly PortfolioGoalDispositionResult[],
	selectedFrontierEntryIds: readonly string[],
	reasons: readonly string[],
	accepted: boolean,
	commitIntent: PortfolioTerminalCommitIntent | null = null,
): PortfolioTerminalEvaluation {
	const sortedGoals = [...goalDispositions].sort((left, right) => left.goalId.localeCompare(right.goalId));
	const unresolvedGoalIds = sortedGoals
		.filter((entry) => entry.disposition !== "achieved")
		.map((entry) => entry.goalId);
	const evaluationDigest = digestObject({
		contractDigest: contractDigest(contract),
		outcome,
		goalDispositions: sortedGoals,
		selectedFrontierEntryIds: sortedStrings(selectedFrontierEntryIds),
		reasons: sortedStrings(reasons),
	});
	return {
		accepted,
		outcome,
		goalDispositions: sortedGoals,
		requiredGoalIds: sortedGoals.map((entry) => entry.goalId),
		unresolvedGoalIds,
		selectedFrontierEntryIds: sortedStrings(selectedFrontierEntryIds),
		reasons: sortedStrings(reasons),
		authority: "host",
		workerCanAuthorize: false,
		candidateCanAuthorize: false,
		mutated: false,
		commitIntent,
		evaluationDigest,
	};
}

function failed(
	contract: AutoResearchPortfolioContract,
	reasons: readonly string[],
	goalDispositions: readonly PortfolioGoalDispositionResult[] = [],
	selectedFrontierEntryIds: readonly string[] = [],
	boundary = false,
): PortfolioTerminalEvaluation {
	return output(
		contract,
		boundary ? "boundary_violation" : "failed",
		goalDispositions,
		selectedFrontierEntryIds,
		reasons,
		false,
		null,
	);
}

function invalidInput(reasons: readonly string[]): PortfolioTerminalEvaluation {
	const sortedReasons = sortedStrings(reasons);
	const outcome: PortfolioTerminalOutcome = "failed";
	return {
		accepted: false,
		outcome,
		goalDispositions: [],
		requiredGoalIds: [],
		unresolvedGoalIds: [],
		selectedFrontierEntryIds: [],
		reasons: sortedReasons,
		authority: "host",
		workerCanAuthorize: false,
		candidateCanAuthorize: false,
		mutated: false,
		commitIntent: null,
		evaluationDigest: digestObject({ kind: "portfolio-terminal-invalid-input.v1", outcome, reasons: sortedReasons }),
	};
}

async function verifyReceipt(
	input: PortfolioTerminalInput,
	receipt: WorkflowVerifiedHostReceipt,
	expectedBindingDigest: string,
	resourceDigest: string,
	operationDigest: string,
): Promise<boolean> {
	try {
		const capabilityBinding = receipt.capabilityBinding;
		if (
			!validCapabilityBindingShape(capabilityBinding) ||
			capabilityBinding.capability !== "portfolio_default_completion" ||
			capabilityBinding.resourceDigest !== resourceDigest ||
			capabilityBinding.operationDigest !== operationDigest
		)
			return false;
		const verified = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest,
			receipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		const key = await input.receiptContext.keyResolver.resolve(verified.keyId);
		const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
			receipt: verified,
			workflowId: input.workflowId,
			bindingDigest: expectedBindingDigest,
			resourceDigest,
			operationDigest,
			stateDigest: input.currentStateDigest,
			revision: input.currentRevision,
			epochRef: key.epochRef,
			capability: "portfolio_default_completion",
			...(capabilityBinding.executionIdentity === null
				? {}
				: { executionIdentity: capabilityBinding.executionIdentity }),
			...(capabilityBinding.sessionId === null ? {} : { sessionId: capabilityBinding.sessionId }),
		};
		const decision = await input.receiptContext.principalAuthorizer.authorize(authorizationInput);
		assertPrincipalAuthorizationDecision(decision, authorizationInput);
		return true;
	} catch {
		return false;
	}
}

function assertPrincipalAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	const expectedDecisionKeys = [
		"authenticatedPrincipal",
		"keyOwnerPrincipal",
		"capability",
		"workflowId",
		"bindingDigest",
		"receipt",
		"stateDigest",
		"revision",
		"epochRef",
		"validity",
		...(input.executionIdentity === undefined ? [] : ["executionIdentity"]),
		...(input.sessionId === undefined ? [] : ["sessionId"]),
		"authorizationDigest",
	] as const;
	if (
		!hasExactKeys(decision, expectedDecisionKeys) ||
		!hasExactKeys(decision.validity, ["issuedAt", "validUntil"]) ||
		!hasExactKeys(decision.epochRef, ["storeEpoch", "coordinatorEpoch"]) ||
		!nonEmptyString(decision.authenticatedPrincipal) ||
		!nonEmptyString(decision.keyOwnerPrincipal) ||
		decision.capability !== input.capability ||
		decision.workflowId !== input.workflowId ||
		decision.bindingDigest !== input.bindingDigest ||
		decision.stateDigest !== input.stateDigest ||
		decision.revision !== input.revision ||
		decision.validity.issuedAt !== input.receipt.issuedAt ||
		decision.validity.validUntil !== input.receipt.validUntil ||
		decision.executionIdentity !== input.executionIdentity ||
		decision.sessionId !== input.sessionId ||
		!isDigestValue(decision.authorizationDigest) ||
		decision.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		digestObject(decision.receipt) !== digestObject(input.receipt)
	) {
		throw new Error("portfolio_terminal_principal_authorization_invalid");
	}
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const actual = ownKeys
		.filter((key): key is string => typeof key === "string")
		.sort((left, right) => left.localeCompare(right));
	const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
	return JSON.stringify(actual) === JSON.stringify(sortedExpected);
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
	return (value as { readonly [key: string]: unknown })[key];
}

function member(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as { readonly [key: string]: unknown })[key];
}

function closedArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value)) return false;
	const length = value.length;
	if (!Number.isSafeInteger(length) || Object.keys(value).length !== length) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (
		ownKeys.some(
			(key) =>
				typeof key !== "string" ||
				(key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
		)
	)
		return false;
	return Array.from({ length }, (_unused, index) => Object.hasOwn(value, index)).every(Boolean);
}

function everyValue(value: unknown, predicate: (entry: unknown) => boolean): boolean {
	return closedArray(value) && value.every(predicate);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
	return isString(value) && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isDigestValue(value: unknown): value is string {
	return typeof value === "string" && isDigest(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function isHostCapabilityReceipt(receipt: WorkflowVerifiedHostReceipt): boolean {
	return (
		receipt.receiptKind === "capability" &&
		receipt.oneUse &&
		receipt.issuerId !== "worker" &&
		receipt.issuerId !== "self" &&
		validCapabilityBindingShape(receipt.capabilityBinding)
	);
}

function validCapabilityBindingShape(value: unknown): value is WorkflowHostReceiptCapabilityBinding {
	return (
		hasExactKeys(value, WORKFLOW_CAPABILITY_BINDING_KEYS) &&
		property(value, "capability") === "portfolio_default_completion" &&
		isDigestValue(property(value, "resourceDigest")) &&
		isDigestValue(property(value, "operationDigest")) &&
		(property(value, "executionIdentity") === null || nonEmptyString(property(value, "executionIdentity"))) &&
		(property(value, "sessionId") === null || nonEmptyString(property(value, "sessionId")))
	);
}

function validStringArray(value: unknown, nonEmpty = false): value is readonly string[] {
	return closedArray(value) && (!nonEmpty || value.length > 0) && value.every(isString);
}

function validReceiptShape(value: unknown): boolean {
	if (
		(!hasExactKeys(value, WORKFLOW_RECEIPT_KEYS) && !hasExactKeys(value, WORKFLOW_RECEIPT_KEYS_WITH_CAPABILITY)) ||
		!hasExactKeys(property(value, "artifactRef"), WORKFLOW_ARTIFACT_REF_KEYS)
	)
		return false;
	const artifactRef = property(value, "artifactRef");
	const capabilityBinding = property(value, "capabilityBinding");
	const hasCapabilityBinding =
		typeof value === "object" && value !== null && Object.hasOwn(value, "capabilityBinding");
	return (
		isOneOf(property(value, "receiptKind"), RECEIPT_KINDS) &&
		typeof property(value, "oneUse") === "boolean" &&
		nonEmptyString(property(value, "receiptId")) &&
		nonEmptyString(property(value, "issuerId")) &&
		nonEmptyString(property(value, "workflowId")) &&
		isDigestValue(property(value, "bindingDigest")) &&
		isDigestValue(property(value, "payloadDigest")) &&
		nonEmptyString(property(value, "issuedAt")) &&
		nonEmptyString(property(value, "validUntil")) &&
		nonEmptyString(property(value, "keyId")) &&
		property(value, "signatureAlgorithm") === "ed25519" &&
		isDigestValue(property(value, "artifactBytesDigest")) &&
		nonEmptyString(property(value, "stateDigest")) &&
		isSafeInteger(property(value, "revision")) &&
		(property(value, "revision") as number) > 0 &&
		nonEmptyString(property(value, "signature")) &&
		isDigestValue(property(value, "verificationDigest")) &&
		(!hasCapabilityBinding || validCapabilityBindingShape(capabilityBinding)) &&
		nonEmptyString(property(artifactRef, "artifactId")) &&
		nonEmptyString(property(artifactRef, "relativePath")) &&
		isDigestValue(property(artifactRef, "digest")) &&
		isSafeInteger(property(artifactRef, "sizeBytes")) &&
		(property(artifactRef, "sizeBytes") as number) >= 0 &&
		isSafeInteger(property(artifactRef, "sourceEventSequence")) &&
		(property(artifactRef, "sourceEventSequence") as number) >= 0
	);
}

function validArtifactShape(value: unknown): boolean {
	if (!hasExactKeys(value, PORTFOLIO_ARTIFACT_KEYS)) return false;
	const verificationEvidenceDigest = property(value, "verificationEvidenceDigest");
	return (
		isOneOf(property(value, "split"), ARTIFACT_SPLITS) &&
		isString(property(value, "objectUri")) &&
		(property(value, "objectUri") as string).length > 0 &&
		isSafeInteger(property(value, "generation")) &&
		(property(value, "generation") as number) > 0 &&
		isDigestValue(property(value, "sha256")) &&
		isSafeInteger(property(value, "bytes")) &&
		(property(value, "bytes") as number) >= 0 &&
		isDigestValue(property(value, "closureRootDigest")) &&
		isOneOf(property(value, "coverage"), ARTIFACT_COVERAGE) &&
		isOneOf(property(value, "gapClassification"), ARTIFACT_GAPS) &&
		isOneOf(property(value, "lifecycle"), ARTIFACT_LIFECYCLES) &&
		typeof property(value, "independentlyRestored") === "boolean" &&
		typeof property(value, "independentlyRehashed") === "boolean" &&
		(verificationEvidenceDigest === null || isDigestValue(verificationEvidenceDigest))
	);
}

function validMeasurementShape(value: unknown): boolean {
	if (!hasExactKeys(value, PORTFOLIO_MEASUREMENT_KEYS)) return false;
	const candidateId = property(value, "candidateId");
	const confidenceInterval = property(value, "confidenceInterval");
	return (
		isString(property(value, "measurementId")) &&
		isString(property(value, "goalId")) &&
		(candidateId === null || isString(candidateId)) &&
		property(value, "scope") === "terminal" &&
		isOneOf(property(value, "kind"), ["baseline", "candidate", "holdout", "replay", "adversarial"] as const) &&
		validVectorShape(property(value, "vector")) &&
		isSafeInteger(property(value, "repeatIndex")) &&
		(property(value, "repeatIndex") as number) >= 0 &&
		isSafeInteger(property(value, "sampleCount")) &&
		(property(value, "sampleCount") as number) >= 0 &&
		isSafeInteger(property(value, "evaluationEpoch")) &&
		(property(value, "evaluationEpoch") as number) > 0 &&
		isDigestValue(property(value, "inputManifestDigest")) &&
		validSplitClosureRootsShape(property(value, "splitClosureRoots")) &&
		hasExactKeys(confidenceInterval, ["lower", "upper", "level"]) &&
		isFiniteNumber(property(confidenceInterval, "lower")) &&
		isFiniteNumber(property(confidenceInterval, "upper")) &&
		isFiniteNumber(property(confidenceInterval, "level")) &&
		(property(confidenceInterval, "lower") as number) <= (property(confidenceInterval, "upper") as number) &&
		(property(confidenceInterval, "level") as number) > 0 &&
		(property(confidenceInterval, "level") as number) <= 1 &&
		isFiniteNumber(property(value, "variance")) &&
		(property(value, "variance") as number) >= 0 &&
		isSafeInteger(property(value, "runCount")) &&
		(property(value, "runCount") as number) >= 0 &&
		isOneOf(property(value, "aggregation"), ["exact", "mean", "median"] as const) &&
		isDigestValue(property(value, "inputDigest")) &&
		isDigestValue(property(value, "evaluatorDigest")) &&
		isDigestValue(property(value, "parserDigest")) &&
		isDigestValue(property(value, "commandDigest")) &&
		isDigestValue(property(value, "workspaceDigest")) &&
		validStringArray(property(value, "evidenceDigests"), true) &&
		(property(value, "evidenceDigests") as readonly unknown[]).every(isDigestValue) &&
		isString(property(value, "measuredAt")) &&
		isDigestValue(property(value, "measurementDigest"))
	);
}

function validVectorShape(value: unknown): boolean {
	return (
		closedArray(value) &&
		value.length > 0 &&
		everyValue(
			value,
			(entry) =>
				hasExactKeys(entry, ["metricId", "value"]) &&
				isString(property(entry, "metricId")) &&
				isFiniteNumber(property(entry, "value")),
		)
	);
}

function validSplitClosureRootsShape(value: unknown): boolean {
	return (
		hasExactKeys(value, ["training", "validation", "holdout"]) &&
		isDigestValue(property(value, "training")) &&
		isDigestValue(property(value, "validation")) &&
		isDigestValue(property(value, "holdout"))
	);
}

function validMeasurementEvidenceShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_HOST_MEASUREMENT_EVIDENCE_KEYS) &&
		validMeasurementShape(property(value, "measurement")) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validFrontierEntryShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_FRONTIER_ENTRY_KEYS) &&
		nonEmptyString(property(value, "entryId")) &&
		nonEmptyString(property(value, "candidateId")) &&
		nonEmptyString(property(value, "domainId")) &&
		validStringArray(property(value, "goalIds"), true) &&
		(property(value, "goalIds") as readonly unknown[]).every(nonEmptyString)
	);
}

function validBoundaryShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_BOUNDARY_KEYS) &&
		nonEmptyString(property(value, "boundaryId")) &&
		typeof property(value, "passed") === "boolean" &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validAcquisitionSplitShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_ACQUISITION_SPLIT_KEYS) &&
		isOneOf(property(value, "split"), ARTIFACT_SPLITS) &&
		everyValue(property(value, "artifacts"), validArtifactShape) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validCompletionShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_COMPLETION_KEYS) &&
		isSafeInteger(property(value, "manifestGeneration")) &&
		(property(value, "manifestGeneration") as number) > 0 &&
		isSafeInteger(property(value, "manifestRevision")) &&
		(property(value, "manifestRevision") as number) > 0 &&
		isDigestValue(property(value, "manifestDigest")) &&
		isDigestValue(property(value, "closureRootDigest")) &&
		everyValue(property(value, "artifacts"), validArtifactShape) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validTradeoffShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_TRADEOFF_KEYS) &&
		validStringArray(property(value, "concessions")) &&
		validStringArray(property(value, "evidenceIds")) &&
		validStringArray(property(value, "selectedFrontierEntryIds")) &&
		everyValue(
			property(value, "floors"),
			(floor) =>
				hasExactKeys(floor, PORTFOLIO_TRADEOFF_FLOOR_KEYS) &&
				isString(property(floor, "goalId")) &&
				isFiniteNumber(property(floor, "value")),
		) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validInfeasibilityShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_INFEASIBILITY_KEYS) &&
		isString(property(value, "goalId")) &&
		isDigestValue(property(value, "evaluatorProofDigest")) &&
		isDigestValue(property(value, "adjudicationDigest")) &&
		validReceiptShape(property(value, "evaluatorProofReceipt")) &&
		validReceiptShape(property(value, "adjudicationReceipt"))
	);
}

function validGoalDecisionShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_GOAL_DECISION_KEYS) &&
		isString(property(value, "goalId")) &&
		isString(property(value, "disposition")) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validStopShape(value: unknown): boolean {
	return (
		hasExactKeys(value, PORTFOLIO_STOP_KEYS) &&
		nonEmptyString(property(value, "reason")) &&
		validReceiptShape(property(value, "receipt"))
	);
}

function validClosedTerminalInput(value: unknown): boolean {
	if (!hasExactKeys(value, PORTFOLIO_TERMINAL_INPUT_KEYS)) return false;
	if (
		!nonEmptyString(property(value, "workflowId")) ||
		!nonEmptyString(property(value, "currentStateDigest")) ||
		!isSafeInteger(property(value, "currentRevision")) ||
		(property(value, "currentRevision") as number) < 1 ||
		!nonEmptyString(property(value, "trustedNow"))
	) {
		return false;
	}
	const receiptContext = property(value, "receiptContext");
	if (
		typeof receiptContext !== "object" ||
		receiptContext === null ||
		(!hasExactKeys(receiptContext, [
			"receiptResolver",
			"keyResolver",
			"revokedReceiptIds",
			"artifactResolver",
			"principalAuthorizer",
		]) &&
			!hasExactKeys(receiptContext, [
				"receiptResolver",
				"keyResolver",
				"revokedReceiptIds",
				"artifactResolver",
				"principalAuthorizer",
				"signer",
			])) ||
		typeof member(property(receiptContext, "receiptResolver"), "resolve") !== "function" ||
		typeof member(property(receiptContext, "receiptResolver"), "consumeIfOneUse") !== "function" ||
		typeof member(property(receiptContext, "receiptResolver"), "resolveConsumptionWitness") !== "function" ||
		typeof member(property(receiptContext, "keyResolver"), "resolve") !== "function" ||
		typeof member(property(receiptContext, "artifactResolver"), "resolve") !== "function" ||
		typeof member(property(receiptContext, "principalAuthorizer"), "authorize") !== "function" ||
		(Object.hasOwn(receiptContext, "signer") &&
			(!hasExactKeys(property(receiptContext, "signer"), ["keyId", "signatureAlgorithm", "sign"]) ||
				!nonEmptyString(property(property(receiptContext, "signer"), "keyId")) ||
				property(property(receiptContext, "signer"), "signatureAlgorithm") !== "ed25519" ||
				typeof member(property(receiptContext, "signer"), "sign") !== "function")) ||
		!(
			property(receiptContext, "revokedReceiptIds") instanceof Set &&
			[...(property(receiptContext, "revokedReceiptIds") as Set<unknown>)].every(nonEmptyString)
		)
	) {
		return false;
	}
	const measurements = property(value, "measurements");
	if (!closedArray(measurements) || !measurements.every(validMeasurementEvidenceShape)) {
		return false;
	}
	const frontier = property(value, "frontier");
	if (
		!hasExactKeys(frontier, PORTFOLIO_FRONTIER_KEYS) ||
		!validStringArray(property(frontier, "selectedEntryIds")) ||
		!everyValue(property(frontier, "entries"), validFrontierEntryShape) ||
		!validReceiptShape(property(frontier, "receipt"))
	) {
		return false;
	}
	const boundaries = property(value, "boundaries");
	if (!closedArray(boundaries) || !boundaries.every(validBoundaryShape)) {
		return false;
	}
	const acquisition = property(value, "acquisition");
	if (
		!hasExactKeys(acquisition, PORTFOLIO_ACQUISITION_KEYS) ||
		!everyValue(property(acquisition, "splits"), validAcquisitionSplitShape)
	) {
		return false;
	}
	const completion = property(value, "completion");
	if (!validCompletionShape(completion)) {
		return false;
	}
	const tradeoff = property(value, "tradeoff");
	if (tradeoff !== null && !validTradeoffShape(tradeoff)) return false;
	const infeasibility = property(value, "infeasibility");
	if (!closedArray(infeasibility) || !infeasibility.every(validInfeasibilityShape)) {
		return false;
	}
	const goalDecisions = property(value, "goalDecisions");
	if (!closedArray(goalDecisions) || !goalDecisions.every(validGoalDecisionShape)) {
		return false;
	}
	const stop = property(value, "stop");
	return stop === null || validStopShape(stop);
}

function parseMeasurementEvidence(
	contract: AutoResearchPortfolioContract,
	evidence: PortfolioHostMeasurementEvidence,
): AutoResearchPortfolioMeasurement | null {
	const rawMeasurement = property(evidence, "measurement");
	const goalId = property(rawMeasurement, "goalId");
	if (typeof goalId !== "string") return null;
	const goal = contract.goals.find((entry) => entry.goalId === goalId);
	if (goal === undefined || goal.scope !== "terminal") return null;
	try {
		const measurement = parseAutoResearchPortfolioMeasurement(structuredClone(rawMeasurement), {
			confidenceLevel: goal.uncertainty.confidence,
			evaluationEpoch: contract.inputManifest.evaluationEpoch,
			inputManifestDigest: contract.inputManifest.manifestDigest,
			splitClosureRoots: contract.inputManifest.splitClosureRoots,
		});
		if (
			measurement.scope !== "terminal" ||
			measurement.candidateId === null ||
			measurement.evaluatorDigest !== goal.evaluator.evaluatorDigest ||
			measurement.parserDigest !== goal.parser.parserDigest ||
			measurement.commandDigest !== goal.command.commandDigest ||
			measurement.vector.length !== goal.metrics.length ||
			!sameStrings(
				measurement.vector.map((entry) => entry.metricId),
				goal.metrics.map((entry) => entry.metricId),
			) ||
			!measurementMeetsPolicy(goal, measurement)
		)
			return null;
		return measurement;
	} catch {
		return null;
	}
}

function measurementBoundaryViolation(
	contract: AutoResearchPortfolioContract,
	evidence: PortfolioHostMeasurementEvidence,
): boolean {
	const rawMeasurement = property(evidence, "measurement");
	return (
		property(rawMeasurement, "inputManifestDigest") !== contract.inputManifest.manifestDigest ||
		!sameSplitClosureRoots(
			property(rawMeasurement, "splitClosureRoots") as AutoResearchPortfolioSplitClosureRoots | null | undefined,
			contract.inputManifest.splitClosureRoots,
		)
	);
}

function validFrontier(contract: AutoResearchPortfolioContract, frontier: PortfolioHostFrontierEvidence): boolean {
	if (
		!hasExactKeys(frontier, PORTFOLIO_FRONTIER_KEYS) ||
		!unique(frontier.entries.map((entry) => entry.entryId)) ||
		!unique(frontier.entries.map((entry) => entry.candidateId)) ||
		!unique(frontier.selectedEntryIds)
	)
		return false;
	const entryIds = new Set(frontier.entries.map((entry) => entry.entryId));
	for (const entry of frontier.entries) {
		if (
			!hasExactKeys(entry, PORTFOLIO_FRONTIER_ENTRY_KEYS) ||
			entry.entryId.trim().length === 0 ||
			entry.candidateId.trim().length === 0 ||
			entry.domainId.trim().length === 0 ||
			!unique(entry.goalIds)
		)
			return false;
		if (
			entry.goalIds.some(
				(goalId) => !contract.goals.some((goal) => goal.goalId === goalId && goal.scope === "terminal"),
			)
		)
			return false;
		if (
			entry.goalIds.some(
				(goalId) => contract.goals.find((goal) => goal.goalId === goalId)?.domainId !== entry.domainId,
			)
		)
			return false;
	}
	if (frontier.selectedEntryIds.some((entryId) => !entryIds.has(entryId))) return false;
	return true;
}

function validCompletion(
	contract: AutoResearchPortfolioContract,
	completion: PortfolioHostCompletionEvidence,
): boolean {
	const manifest = contract.inputManifest;
	const expectedArtifacts = manifestArtifacts(contract);
	const observedSplits = new Set(completion.artifacts.map((artifact) => artifact.split));
	const observedRoots = new Set(completion.artifacts.map((artifact) => artifact.closureRootDigest));
	return (
		completion.manifestGeneration === manifest.evaluationEpoch &&
		completion.manifestRevision === manifest.manifestRevision &&
		completion.manifestDigest === manifest.manifestDigest &&
		completion.closureRootDigest === manifest.closureRootDigest &&
		observedSplits.size === 3 &&
		observedRoots.size === observedSplits.size &&
		completion.artifacts.every(
			(artifact) =>
				artifact.independentlyRestored && artifact.independentlyRehashed && artifact.lifecycle === "sealed",
		) &&
		sameArtifacts(completion.artifacts, expectedArtifacts)
	);
}

function validAcquisition(
	contract: AutoResearchPortfolioContract,
	acquisition: PortfolioHostAcquisitionEvidence,
): boolean {
	if (acquisition.splits.length !== 3 || !unique(acquisition.splits.map((entry) => entry.split))) return false;
	const expectedArtifacts = manifestArtifacts(contract);
	for (const split of ["training", "validation", "holdout"] as const) {
		const evidence = acquisition.splits.find((entry) => entry.split === split);
		if (
			evidence === undefined ||
			!sameAcquisitionArtifacts(
				evidence.artifacts,
				expectedArtifacts.filter((artifact) => artifact.split === split),
			) ||
			evidence.artifacts.some(
				(artifact) =>
					artifact.split !== split ||
					(artifact.coverage === "complete" && artifact.gapClassification !== "none") ||
					(artifact.coverage !== "complete" && artifact.gapClassification !== artifact.coverage),
			)
		)
			return false;
	}
	return true;
}

function metricValue(measurement: AutoResearchPortfolioMeasurement, metricId: string): number | null {
	return measurement.vector.find((entry) => entry.metricId === metricId)?.value ?? null;
}

function goalDisposition(
	contract: AutoResearchPortfolioContract,
	goalId: string,
	selectedEntryIds: readonly string[],
	frontier: PortfolioHostFrontierEvidence,
	measurements: readonly AutoResearchPortfolioMeasurement[],
	decisions: readonly PortfolioHostGoalDecisionEvidence[],
): PortfolioGoalDisposition {
	const goal = contract.goals.find((entry) => entry.goalId === goalId)!;
	const selectedCandidateIds = frontier.entries
		.filter((entry) => selectedEntryIds.includes(entry.entryId) && entry.goalIds.includes(goalId))
		.map((entry) => entry.candidateId);
	const candidates = measurements
		.filter(
			(entry) =>
				entry.candidateId !== null &&
				entry.kind === "candidate" &&
				selectedCandidateIds.includes(entry.candidateId),
		)
		.filter((measurement) => measurement.goalId === goalId);
	const baseline = new Map(goal.baseline.metricValues.map((entry) => [entry.metricId, entry.value]));
	for (const measurement of candidates) {
		const achieved = goal.metrics.every((metric) => {
			const value = metricValue(measurement, metric.metricId);
			return value !== null && (metric.direction === "higher" ? value >= metric.target : value <= metric.target);
		});
		if (achieved) return "achieved";
	}
	const decision = decisions.find((entry) => entry.goalId === goalId)?.disposition;
	if (decision !== undefined) return decision;
	for (const measurement of candidates) {
		if (
			goal.metrics.some((metric) => {
				const value = metricValue(measurement, metric.metricId);
				const previous = baseline.get(metric.metricId);
				return (
					value !== null &&
					previous !== undefined &&
					(metric.direction === "higher" ? value < previous : value > previous)
				);
			})
		)
			return "regressed";
	}
	return "active";
}

function metricsMeetGoal(
	goal: AutoResearchPortfolioContract["goals"][number],
	measurement: AutoResearchPortfolioMeasurement,
): boolean {
	return goal.metrics.every((metric) => {
		const value = metricValue(measurement, metric.metricId);
		return value !== null && (metric.direction === "higher" ? value >= metric.target : value <= metric.target);
	});
}

function measurementMeetsPolicy(
	goal: AutoResearchPortfolioContract["goals"][number],
	measurement: AutoResearchPortfolioMeasurement,
): boolean {
	const width = measurement.confidenceInterval.upper - measurement.confidenceInterval.lower;
	return (
		measurement.runCount === goal.repeatability.runs &&
		measurement.aggregation === goal.repeatability.aggregation &&
		measurement.variance <= goal.repeatability.maxVariance &&
		measurement.confidenceInterval.level === goal.uncertainty.confidence &&
		width <= goal.uncertainty.maxWidth &&
		measurement.variance <= goal.uncertainty.maxVariance
	);
}

function hasFreshTerminalEvidence(
	contract: AutoResearchPortfolioContract,
	goalId: string,
	selectedEntryIds: readonly string[],
	frontier: PortfolioHostFrontierEvidence,
	measurements: readonly AutoResearchPortfolioMeasurement[],
): boolean {
	const goal = contract.goals.find((entry) => entry.goalId === goalId);
	if (goal === undefined || goal.scope !== "terminal") return false;
	const selectedCandidateIds = frontier.entries
		.filter((entry) => selectedEntryIds.includes(entry.entryId) && entry.goalIds.includes(goalId))
		.map((entry) => entry.candidateId);
	return selectedCandidateIds.some((candidateId) => {
		const candidate = measurements.find(
			(entry) => entry.goalId === goalId && entry.kind === "candidate" && entry.candidateId === candidateId,
		);
		const holdout = measurements.find(
			(entry) => entry.goalId === goalId && entry.kind === "holdout" && entry.candidateId === candidateId,
		);
		const adversarial = measurements.find(
			(entry) => entry.goalId === goalId && entry.kind === "adversarial" && entry.candidateId === candidateId,
		);
		return (
			candidate !== undefined &&
			holdout !== undefined &&
			adversarial !== undefined &&
			measurementMeetsPolicy(goal, candidate) &&
			measurementMeetsPolicy(goal, holdout) &&
			measurementMeetsPolicy(goal, adversarial) &&
			metricsMeetGoal(goal, candidate) &&
			metricsMeetGoal(goal, holdout) &&
			metricsMeetGoal(goal, adversarial)
		);
	});
}

function validTradeoff(
	contract: AutoResearchPortfolioContract,
	tradeoff: PortfolioHostTradeoffEvidence,
	unresolvedGoalIds: readonly string[],
	measurements: readonly AutoResearchPortfolioMeasurement[],
	frontier: PortfolioHostFrontierEvidence,
	selectedFrontierEntryIds: readonly string[],
): boolean {
	if (
		unresolvedGoalIds.length === 0 ||
		tradeoff.selectedFrontierEntryIds.length === 0 ||
		tradeoff.evidenceIds.length === 0 ||
		!unique(tradeoff.concessions) ||
		!unique(tradeoff.evidenceIds) ||
		!unique(tradeoff.selectedFrontierEntryIds) ||
		!sameStrings(tradeoff.concessions, unresolvedGoalIds) ||
		!sameStrings(tradeoff.selectedFrontierEntryIds, selectedFrontierEntryIds)
	)
		return false;
	if (
		!sameStrings(
			tradeoff.floors.map((floor) => floor.goalId),
			unresolvedGoalIds,
		)
	)
		return false;
	if (tradeoff.floors.some((floor) => !Number.isFinite(floor.value))) return false;
	const selectedEntries = frontier.entries.filter((entry) => selectedFrontierEntryIds.includes(entry.entryId));
	if (
		selectedEntries.length === 0 ||
		unresolvedGoalIds.some((goalId) => !selectedEntries.some((entry) => entry.goalIds.includes(goalId)))
	)
		return false;
	const tradeoffGoalIds = new Set(
		contract.goalRelations
			.filter(
				(relation) =>
					(relation.relation === "competing" || relation.relation === "conflict") &&
					contract.goals.some((goal) => goal.goalId === relation.fromGoalId && goal.scope === "terminal") &&
					contract.goals.some((goal) => goal.goalId === relation.toGoalId && goal.scope === "terminal"),
			)
			.flatMap((relation) => [relation.fromGoalId, relation.toGoalId]),
	);
	if (unresolvedGoalIds.some((goalId) => !tradeoffGoalIds.has(goalId))) return false;
	for (const floor of tradeoff.floors) {
		const goal = contract.goals.find((entry) => entry.goalId === floor.goalId);
		if (goal === undefined || goal.metrics.length !== 1) return false;
		const metric = goal.metrics[0]!;
		const baseline = goal.baseline.metricValues.find((entry) => entry.metricId === metric.metricId)?.value;
		if (baseline === undefined) return false;
		const lower = Math.min(baseline, metric.target);
		const upper = Math.max(baseline, metric.target);
		if (floor.value < lower || floor.value > upper) return false;
	}
	const selectedCandidateIds = frontier.entries
		.filter((entry) => selectedFrontierEntryIds.includes(entry.entryId))
		.map((entry) => entry.candidateId);
	const expectedEvidenceIds = measurements
		.filter(
			(entry) =>
				entry.candidateId !== null &&
				(entry.kind === "candidate" || entry.kind === "holdout" || entry.kind === "adversarial") &&
				selectedCandidateIds.includes(entry.candidateId),
		)
		.map((entry) => entry.measurementId);
	return sameStrings(tradeoff.evidenceIds, expectedEvidenceIds);
}

export async function evaluatePortfolioTerminal(input: PortfolioTerminalInput): Promise<PortfolioTerminalEvaluation> {
	try {
		return await evaluatePortfolioTerminalInner(input);
	} catch {
		return invalidInput(["terminal input failed closed host evaluation"]);
	}
}

async function evaluatePortfolioTerminalInner(input: PortfolioTerminalInput): Promise<PortfolioTerminalEvaluation> {
	if (!validClosedTerminalInput(input)) {
		return invalidInput(["terminal input has an unknown or malformed evidence shape"]);
	}
	let contract: AutoResearchPortfolioContract;
	try {
		// The contract parser requires mutable own array records before it returns its frozen canonical clone.
		contract = parseAutoResearchPortfolioContract(structuredClone(input.contract));
	} catch {
		return invalidInput(["terminal evaluation requires a canonical schema-v3 contract"]);
	}
	const requiredGoalIds = contract.goals.filter((goal) => goal.scope === "terminal").map((goal) => goal.goalId);
	const terminalBoundaries = contract.hardBoundaries.filter((boundary) => boundary.scope === "terminal");
	const initialGoals = requiredGoalIds.map((goalId) => ({ goalId, disposition: "active" as const }));
	const parsedMeasurements: AutoResearchPortfolioMeasurement[] = [];
	for (const evidence of input.measurements) {
		const measurement = parseMeasurementEvidence(contract, evidence);
		if (measurement === null)
			return failed(
				contract,
				["host measurement omits or mutates a canonical contract-bound vector"],
				initialGoals,
				[],
				measurementBoundaryViolation(contract, evidence),
			);
		parsedMeasurements.push(measurement);
	}
	if (!unique(parsedMeasurements.map((entry) => entry.measurementId)))
		return failed(contract, ["host measurement identifiers are duplicated"], initialGoals);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(contract, input, parsedMeasurements);
	if (!validFrontier(contract, input.frontier))
		return failed(contract, ["frontier evidence is not host-bound"], initialGoals);
	const selectedFrontierEntryIds = sortedStrings(input.frontier.selectedEntryIds);
	for (const boundary of terminalBoundaries) {
		const evidence = input.boundaries.filter((entry) => entry.boundaryId === boundary.boundaryId);
		if (evidence.length !== 1)
			return failed(
				contract,
				["hard-boundary evidence is incomplete"],
				initialGoals,
				selectedFrontierEntryIds,
				true,
			);
		const item = evidence[0]!;
		if (
			!isHostCapabilityReceipt(item.receipt) ||
			!(await verifyReceipt(
				input,
				item.receipt,
				portfolioBoundaryBindingDigest(contract, item.boundaryId, item.passed),
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(
					contract,
					input,
					parsedMeasurements,
					"boundary",
					portfolioBoundaryBindingDigest(contract, item.boundaryId, item.passed),
				),
			))
		)
			return failed(
				contract,
				["hard-boundary receipt is not independently verified"],
				initialGoals,
				selectedFrontierEntryIds,
				true,
			);
		if (!item.passed)
			return failed(contract, ["a locked hard boundary was violated"], initialGoals, selectedFrontierEntryIds, true);
	}
	if (input.boundaries.length !== terminalBoundaries.length)
		return failed(
			contract,
			["unknown hard-boundary evidence is not admissible"],
			initialGoals,
			selectedFrontierEntryIds,
			true,
		);
	if (
		!isHostCapabilityReceipt(input.frontier.receipt) ||
		!(await verifyReceipt(
			input,
			input.frontier.receipt,
			portfolioFrontierBindingDigest(contract, input.frontier.entries, input.frontier.selectedEntryIds),
			resourceDigest,
			portfolioDefaultCompletionOperationDigest(
				contract,
				input,
				parsedMeasurements,
				"frontier",
				portfolioFrontierBindingDigest(contract, input.frontier.entries, input.frontier.selectedEntryIds),
			),
		))
	)
		return failed(
			contract,
			["frontier receipt is not independently verified"],
			initialGoals,
			selectedFrontierEntryIds,
		);
	if (!validAcquisition(contract, input.acquisition))
		return failed(
			contract,
			["acquisition evidence is not bound to the immutable split artifacts"],
			initialGoals,
			selectedFrontierEntryIds,
			true,
		);
	for (const split of input.acquisition.splits) {
		if (
			!isHostCapabilityReceipt(split.receipt) ||
			!(await verifyReceipt(
				input,
				split.receipt,
				portfolioAcquisitionBindingDigest(contract, split.split, split.artifacts),
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(
					contract,
					input,
					parsedMeasurements,
					"acquisition",
					portfolioAcquisitionBindingDigest(contract, split.split, split.artifacts),
				),
			))
		)
			return failed(
				contract,
				["acquisition receipt is not independently verified"],
				initialGoals,
				selectedFrontierEntryIds,
				true,
			);
	}
	if (!validCompletion(contract, input.completion))
		return failed(
			contract,
			["completion does not prove exact immutable split generations and independent restore/rehash"],
			initialGoals,
			selectedFrontierEntryIds,
			true,
		);
	if (
		!isHostCapabilityReceipt(input.completion.receipt) ||
		!(await verifyReceipt(
			input,
			input.completion.receipt,
			portfolioCompletionBindingDigest(contract, input.completion),
			resourceDigest,
			portfolioDefaultCompletionOperationDigest(
				contract,
				input,
				parsedMeasurements,
				"completion",
				portfolioCompletionBindingDigest(contract, input.completion),
			),
		))
	)
		return failed(
			contract,
			["completion receipt is not independently verified"],
			initialGoals,
			selectedFrontierEntryIds,
			true,
		);
	for (const evidence of input.measurements) {
		const measurement = parseMeasurementEvidence(contract, evidence);
		if (
			!isHostCapabilityReceipt(evidence.receipt) ||
			measurement === null ||
			!(await verifyReceipt(
				input,
				evidence.receipt,
				portfolioMeasurementBindingDigest(contract, measurement),
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(
					contract,
					input,
					parsedMeasurements,
					"measurement",
					portfolioMeasurementBindingDigest(contract, measurement),
				),
			))
		)
			return failed(
				contract,
				["measurement receipt is not independently verified"],
				initialGoals,
				selectedFrontierEntryIds,
			);
	}
	if (!unique(input.goalDecisions.map((entry) => entry.goalId)))
		return failed(contract, ["host goal decisions are duplicated"], initialGoals, selectedFrontierEntryIds);
	if (!unique(input.infeasibility.map((entry) => entry.goalId)))
		return failed(contract, ["host infeasibility evidence is duplicated"], initialGoals, selectedFrontierEntryIds);
	for (const decision of input.goalDecisions) {
		const decisionBinding = portfolioGoalDecisionBindingDigest(contract, decision.goalId, decision.disposition);
		if (
			!requiredGoalIds.includes(decision.goalId) ||
			!PORTFOLIO_HOST_GOAL_DECISIONS.includes(decision.disposition) ||
			!isHostCapabilityReceipt(decision.receipt) ||
			!(await verifyReceipt(
				input,
				decision.receipt,
				decisionBinding,
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(
					contract,
					input,
					parsedMeasurements,
					"goal_decision",
					decisionBinding,
				),
			))
		)
			return failed(
				contract,
				["goal disposition evidence is not host-authenticated"],
				initialGoals,
				selectedFrontierEntryIds,
			);
	}
	const withdrawalDecisions = input.goalDecisions.filter((entry) => entry.disposition === "withdrawn_by_user");
	if (withdrawalDecisions.length > 1)
		return failed(
			contract,
			["multiple one-use withdrawal decisions cannot be consumed atomically"],
			initialGoals,
			selectedFrontierEntryIds,
		);
	const coverage = input.acquisition.splits.flatMap((split) => split.artifacts.map((artifact) => artifact.coverage));
	const unknownCoverage = coverage.some((entry) => entry === "unknown" || entry === "missing");
	const providerEmpty = coverage.some((entry) => entry === "provider_empty");
	const partialCoverage = coverage.some((entry) => entry === "partial_coverage");
	const goalDispositions = requiredGoalIds.map((goalId) => ({
		goalId,
		disposition: goalDisposition(
			contract,
			goalId,
			selectedFrontierEntryIds,
			input.frontier,
			parsedMeasurements,
			input.goalDecisions,
		),
	}));
	const evidenceCompleteByGoal = new Map(
		requiredGoalIds.map((goalId) => [
			goalId,
			hasFreshTerminalEvidence(contract, goalId, selectedFrontierEntryIds, input.frontier, parsedMeasurements),
		]),
	);
	const evidenceAdjustedGoalDispositions = goalDispositions.map((entry) =>
		entry.disposition === "achieved" && evidenceCompleteByGoal.get(entry.goalId) !== true
			? {
					...entry,
					disposition: (input.goalDecisions.find((decision) => decision.goalId === entry.goalId)?.disposition ??
						"active") as PortfolioGoalDisposition,
				}
			: entry,
	);
	const coverageAdjustedGoalDispositions = providerEmpty
		? evidenceAdjustedGoalDispositions.map((entry) =>
				entry.disposition === "active" ? { ...entry, disposition: "search_exhausted" as const } : entry,
			)
		: evidenceAdjustedGoalDispositions;
	const unresolvedGoalIds = coverageAdjustedGoalDispositions
		.filter((entry) => entry.disposition !== "achieved")
		.map((entry) => entry.goalId);
	if (input.stop !== null) {
		const stopBinding = portfolioStopBindingDigest(contract, input.stop.reason);
		if (withdrawalDecisions.length > 0)
			return failed(
				contract,
				["stop and withdrawal decisions cannot be combined"],
				coverageAdjustedGoalDispositions,
				selectedFrontierEntryIds,
			);
		if (
			!isHostCapabilityReceipt(input.stop.receipt) ||
			!(await verifyReceipt(
				input,
				input.stop.receipt,
				stopBinding,
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(contract, input, parsedMeasurements, "stop", stopBinding),
			))
		)
			return failed(
				contract,
				["stop receipt is not an authenticated user decision"],
				coverageAdjustedGoalDispositions,
				selectedFrontierEntryIds,
			);
		return output(
			contract,
			"stopped",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			["user requested stop"],
			true,
			commitIntentFor(input, contract, "stopped"),
		);
	}
	if (unresolvedGoalIds.length === 0 && !unknownCoverage && !partialCoverage && !providerEmpty) {
		const commitIntent = commitIntentFor(input, contract, "complete");
		if (commitIntent === null)
			return failed(
				contract,
				["complete terminal decision lacks one-use host capability receipts"],
				coverageAdjustedGoalDispositions,
				selectedFrontierEntryIds,
			);
		return output(
			contract,
			"complete",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			[],
			true,
			commitIntent,
		);
	}
	if (
		unresolvedGoalIds.length > 0 &&
		input.tradeoff !== null &&
		withdrawalDecisions.length === 0 &&
		!unknownCoverage &&
		!partialCoverage &&
		!providerEmpty
	) {
		if (
			!isHostCapabilityReceipt(input.tradeoff.receipt) ||
			!validTradeoff(
				contract,
				input.tradeoff,
				unresolvedGoalIds,
				parsedMeasurements,
				input.frontier,
				selectedFrontierEntryIds,
			) ||
			!(await verifyReceipt(
				input,
				input.tradeoff.receipt,
				portfolioTradeoffBindingDigest(contract, input.tradeoff),
				resourceDigest,
				portfolioDefaultCompletionOperationDigest(
					contract,
					input,
					parsedMeasurements,
					"tradeoff",
					portfolioTradeoffBindingDigest(contract, input.tradeoff),
				),
			))
		)
			return output(
				contract,
				"partial_success",
				coverageAdjustedGoalDispositions,
				selectedFrontierEntryIds,
				["user tradeoff authority is missing or invalid"],
				false,
			);
		const commitIntent = commitIntentFor(input, contract, "complete_with_tradeoff");
		if (commitIntent === null)
			return output(
				contract,
				"partial_success",
				coverageAdjustedGoalDispositions,
				selectedFrontierEntryIds,
				["complete-with-tradeoff decision lacks one-use host capability receipts"],
				false,
			);
		return output(
			contract,
			"complete_with_tradeoff",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			["user signed a bounded tradeoff"],
			true,
			commitIntent,
		);
	}
	if (
		unresolvedGoalIds.length > 0 &&
		withdrawalDecisions.length === 0 &&
		!unknownCoverage &&
		!partialCoverage &&
		!providerEmpty
	) {
		const proofs = input.infeasibility.filter((entry) => unresolvedGoalIds.includes(entry.goalId));
		if (proofs.length === unresolvedGoalIds.length && unique(proofs.map((entry) => entry.goalId))) {
			for (const proof of proofs) {
				if (
					!isDigest(proof.evaluatorProofDigest) ||
					!isDigest(proof.adjudicationDigest) ||
					!isHostCapabilityReceipt(proof.evaluatorProofReceipt) ||
					!isHostCapabilityReceipt(proof.adjudicationReceipt) ||
					proof.evaluatorProofReceipt.receiptId === proof.adjudicationReceipt.receiptId ||
					!(await verifyReceipt(
						input,
						proof.evaluatorProofReceipt,
						portfolioInfeasibilityProofBindingDigest(contract, proof.goalId, proof.evaluatorProofDigest),
						resourceDigest,
						portfolioDefaultCompletionOperationDigest(
							contract,
							input,
							parsedMeasurements,
							"infeasibility_evaluator",
							portfolioInfeasibilityProofBindingDigest(contract, proof.goalId, proof.evaluatorProofDigest),
						),
					)) ||
					!(await verifyReceipt(
						input,
						proof.adjudicationReceipt,
						portfolioInfeasibilityAdjudicationBindingDigest(
							contract,
							proof.goalId,
							proof.evaluatorProofDigest,
							proof.adjudicationDigest,
						),
						resourceDigest,
						portfolioDefaultCompletionOperationDigest(
							contract,
							input,
							parsedMeasurements,
							"infeasibility_adjudicator",
							portfolioInfeasibilityAdjudicationBindingDigest(
								contract,
								proof.goalId,
								proof.evaluatorProofDigest,
								proof.adjudicationDigest,
							),
						),
					))
				)
					return failed(
						contract,
						["infeasibility lacks independent evaluator proof and adjudication"],
						coverageAdjustedGoalDispositions,
						selectedFrontierEntryIds,
					);
			}
			return output(
				contract,
				"infeasible",
				coverageAdjustedGoalDispositions.map((entry) =>
					unresolvedGoalIds.includes(entry.goalId) ? { ...entry, disposition: "infeasible" as const } : entry,
				),
				selectedFrontierEntryIds,
				["independent host infeasibility adjudication verified"],
				true,
			);
		}
	}
	const anyAchieved = coverageAdjustedGoalDispositions.some((entry) => entry.disposition === "achieved");
	const allUnresolvedSearchExhausted =
		unresolvedGoalIds.length > 0 &&
		unresolvedGoalIds.every(
			(goalId) =>
				coverageAdjustedGoalDispositions.find((entry) => entry.goalId === goalId)?.disposition ===
				"search_exhausted",
		);
	if (!unknownCoverage && !partialCoverage && !anyAchieved && allUnresolvedSearchExhausted)
		return output(
			contract,
			"search_exhausted",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			["host acquisition was explicitly empty"],
			true,
		);
	if (withdrawalDecisions.length === 1) {
		return output(
			contract,
			anyAchieved ? "partial_success" : "stopped",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			["user withdrew an unresolved goal"],
			true,
			commitIntentFor(input, contract, anyAchieved ? "partial_success" : "stopped"),
		);
	}
	if (anyAchieved)
		return output(
			contract,
			"partial_success",
			coverageAdjustedGoalDispositions,
			selectedFrontierEntryIds,
			["some required goals remain unresolved"],
			true,
		);
	return output(
		contract,
		"failed",
		coverageAdjustedGoalDispositions,
		selectedFrontierEntryIds,
		[unknownCoverage ? "acquisition coverage is unknown" : "required goals remain unresolved"],
		false,
	);
}
