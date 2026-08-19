import {
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	type AutoResearchPortfolioReadOnlyProvenance,
	autoResearchPortfolioCandidateDigest,
	autoResearchPortfolioContractDigest,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
} from "./portfolio-contracts.js";
import {
	type AutoResearchPortfolioImpactClosure,
	deriveAutoResearchPortfolioImpactClosure,
} from "./portfolio-frontier.js";
import {
	evaluatePortfolioTerminal,
	PORTFOLIO_GOAL_DISPOSITIONS,
	PORTFOLIO_TERMINAL_OUTCOMES,
	type PortfolioGoalDisposition,
	type PortfolioTerminalCommitIntent,
	type PortfolioTerminalEvaluation,
	type PortfolioTerminalInput,
} from "./portfolio-terminal.js";

/** Version of the durable portfolio projection envelope. */
export const AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION = 1 as const;

const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/u;
const CAPABILITY = "autoresearch_portfolio_projection_commit" as const;
const EVENT_KINDS = [
	"candidate_registered",
	"impact_closure_recorded",
	"host_vector_measured",
	"opaque_holdout_aggregate_recorded",
	"frontier_disposition_recorded",
	"terminal_decision_recorded",
	"learning_decision_recorded",
	"budget_usage_recorded",
	"epoch_advanced",
	"status_changed",
] as const;
const FRONTIER_DISPOSITIONS = ["admitted", "retained", "exploratory", "discarded", "rejected", "superseded"] as const;
const LEARNING_SCOPES = ["goal", "domain", "global", "never"] as const;
const LEARNING_DISPOSITIONS = ["accepted", "exploratory", "rejected"] as const;
const STATUSES = ["active", "paused", "budget_limited", "blocked", "failed", "cancelled", "complete"] as const;
const TERMINAL_STATUSES = ["budget_limited", "blocked", "failed", "cancelled", "complete"] as const;

/** Runtime allowlist for the one closed projection event union. */
export const AUTO_RESEARCH_PORTFOLIO_PROJECTION_EVENT_KINDS = Object.freeze([...EVENT_KINDS]);

export type AutoResearchPortfolioProjectionEventKind = (typeof EVENT_KINDS)[number];
export type AutoResearchPortfolioProjectionStatus = (typeof STATUSES)[number];
export type AutoResearchPortfolioProjectionCandidateLifecycle =
	| "registered"
	| "measured"
	| "frontier_exploratory"
	| "frontier_admitted"
	| "frontier_discarded"
	| "terminal_decided"
	| "learning_decided";
export type AutoResearchPortfolioProjectionFrontierDisposition = (typeof FRONTIER_DISPOSITIONS)[number];
export type AutoResearchPortfolioProjectionLearningScope = (typeof LEARNING_SCOPES)[number];
export type AutoResearchPortfolioProjectionLearningDisposition = (typeof LEARNING_DISPOSITIONS)[number];

export interface AutoResearchPortfolioProjectionBudgetLimits {
	readonly maxCandidates?: number;
	readonly maxMeasurements?: number;
	readonly maxWallMilliseconds?: number;
	readonly maxCostMicrounits?: number;
	readonly maxTokens?: number;
}

export interface AutoResearchPortfolioProjectionResourceUsage {
	readonly candidates: number;
	readonly measurements: number;
	readonly wallMilliseconds: number;
	readonly costMicrounits: number;
	readonly tokens: number;
}

export interface AutoResearchPortfolioProjectionInput {
	readonly projectionId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly contract: AutoResearchPortfolioContract;
	readonly provenance: AutoResearchPortfolioReadOnlyProvenance;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly budget?: AutoResearchPortfolioProjectionBudgetLimits;
}

export interface AutoResearchPortfolioProjectionCandidate extends AutoResearchPortfolioCandidate {
	readonly candidateDigest: string;
	readonly lifecycle: AutoResearchPortfolioProjectionCandidateLifecycle;
	readonly measurementIds: readonly string[];
	readonly impactClosureDigest: string | null;
	readonly frontierDisposition: AutoResearchPortfolioProjectionFrontierDisposition | null;
	readonly terminalDecisionId: string | null;
	readonly learningDecisionId: string | null;
}

export interface AutoResearchPortfolioProjectionFrontierRecord {
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly disposition: AutoResearchPortfolioProjectionFrontierDisposition;
	readonly frontierDigest: string;
}

export interface AutoResearchPortfolioProjectionImpactClosureRecord {
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
	readonly closureDigest: string;
}

export interface AutoResearchPortfolioProjectionTerminalDecision {
	readonly decisionId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly terminalEvaluation: PortfolioTerminalEvaluation;
	readonly terminalEvidenceDigest: string;
	readonly evidenceDigest: string;
}

export interface AutoResearchPortfolioProjectionLearningDecision {
	readonly decisionId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly scope: AutoResearchPortfolioProjectionLearningScope;
	readonly disposition: AutoResearchPortfolioProjectionLearningDisposition;
	readonly evidenceDigest: string;
}

export interface AutoResearchPortfolioProjectionOpaqueHoldoutAggregate {
	readonly aggregateId: string;
	readonly goalId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly aggregateDigest: string;
	readonly evidenceDigest: string;
}

export interface AutoResearchPortfolioProjectionResolvedBudgetLimits {
	readonly maxCandidates: number | null;
	readonly maxMeasurements: number | null;
	readonly maxWallMilliseconds: number | null;
	readonly maxCostMicrounits: number | null;
	readonly maxTokens: number | null;
}

export interface AutoResearchPortfolioProjectionEventReceipt {
	readonly eventId: string;
	readonly eventDigest: string;
}

export type AutoResearchPortfolioProjectionTerminalEvidence = Omit<
	PortfolioTerminalInput,
	"contract" | "workflowId" | "currentStateDigest" | "currentRevision" | "trustedNow" | "receiptContext"
>;

export interface AutoResearchPortfolioProjectionState {
	readonly schemaVersion: typeof AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION;
	readonly projectionId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly contractDigest: string;
	readonly contract: AutoResearchPortfolioContract;
	readonly revision: number;
	readonly head: string | null;
	readonly epoch: number;
	readonly provenance: AutoResearchPortfolioReadOnlyProvenance;
	readonly authority: WorkflowHostPrincipalCapabilityAuthorization | null;
	readonly status: AutoResearchPortfolioProjectionStatus;
	readonly statusReason: string | null;
	readonly candidates: readonly AutoResearchPortfolioProjectionCandidate[];
	readonly impactClosures: readonly AutoResearchPortfolioProjectionImpactClosureRecord[];
	readonly measurements: readonly AutoResearchPortfolioMeasurement[];
	readonly frontier: readonly AutoResearchPortfolioProjectionFrontierRecord[];
	readonly terminalDecisions: readonly AutoResearchPortfolioProjectionTerminalDecision[];
	readonly learningDecisions: readonly AutoResearchPortfolioProjectionLearningDecision[];
	readonly holdoutAggregates: readonly AutoResearchPortfolioProjectionOpaqueHoldoutAggregate[];
	readonly budgetLimits: AutoResearchPortfolioProjectionResolvedBudgetLimits;
	readonly budgetUsage: AutoResearchPortfolioProjectionResourceUsage;
	readonly appliedEventIds: readonly string[];
	readonly appliedEventDigests: readonly string[];
	readonly appliedEvents: readonly AutoResearchPortfolioProjectionEventReceipt[];
	readonly projectionDigest: string;
}

interface ProjectionEventBase {
	readonly schemaVersion: typeof AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION;
	readonly eventId: string;
	readonly eventDigest: string;
	readonly projectionId: string;
	readonly revision: number;
	readonly epoch: number;
	readonly occurredAt: string;
	readonly contractDigest: string;
	readonly provenance: AutoResearchPortfolioReadOnlyProvenance;
	readonly priorHead: string | null;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface AutoResearchPortfolioProjectionCandidateRegisteredEvent extends ProjectionEventBase {
	readonly kind: "candidate_registered";
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly candidateDigest: string;
}
export interface AutoResearchPortfolioProjectionImpactClosureRecordedEvent extends ProjectionEventBase {
	readonly kind: "impact_closure_recorded";
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
}
export interface AutoResearchPortfolioProjectionHostVectorMeasuredEvent extends ProjectionEventBase {
	readonly kind: "host_vector_measured";
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly measurement: AutoResearchPortfolioMeasurement;
}
export interface AutoResearchPortfolioProjectionOpaqueHoldoutAggregateRecordedEvent extends ProjectionEventBase {
	readonly kind: "opaque_holdout_aggregate_recorded";
	readonly aggregateId: string;
	readonly goalId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly aggregateDigest: string;
	readonly evidenceDigest: string;
}
export interface AutoResearchPortfolioProjectionFrontierDispositionRecordedEvent extends ProjectionEventBase {
	readonly kind: "frontier_disposition_recorded";
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly disposition: AutoResearchPortfolioProjectionFrontierDisposition;
	readonly frontierDigest: string;
}
export interface AutoResearchPortfolioProjectionTerminalDecisionRecordedEvent extends ProjectionEventBase {
	readonly kind: "terminal_decision_recorded";
	readonly decisionId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly terminalEvaluation: PortfolioTerminalEvaluation;
	readonly terminalEvidence: AutoResearchPortfolioProjectionTerminalEvidence;
	readonly evidenceDigest: string;
}
export interface AutoResearchPortfolioProjectionLearningDecisionRecordedEvent extends ProjectionEventBase {
	readonly kind: "learning_decision_recorded";
	readonly decisionId: string;
	readonly candidateId: string | null;
	readonly candidateDigest: string | null;
	readonly scope: AutoResearchPortfolioProjectionLearningScope;
	readonly disposition: AutoResearchPortfolioProjectionLearningDisposition;
	readonly evidenceDigest: string;
}
export interface AutoResearchPortfolioProjectionBudgetUsageRecordedEvent extends ProjectionEventBase {
	readonly kind: "budget_usage_recorded";
	readonly usage: AutoResearchPortfolioProjectionResourceUsageInput;
}
export interface AutoResearchPortfolioProjectionEpochAdvancedEvent extends ProjectionEventBase {
	readonly kind: "epoch_advanced";
	readonly fromEpoch: number;
}
export interface AutoResearchPortfolioProjectionStatusChangedEvent extends ProjectionEventBase {
	readonly kind: "status_changed";
	readonly status: AutoResearchPortfolioProjectionStatus;
	readonly reason: string;
}

export type AutoResearchPortfolioProjectionEvent =
	| AutoResearchPortfolioProjectionCandidateRegisteredEvent
	| AutoResearchPortfolioProjectionImpactClosureRecordedEvent
	| AutoResearchPortfolioProjectionHostVectorMeasuredEvent
	| AutoResearchPortfolioProjectionOpaqueHoldoutAggregateRecordedEvent
	| AutoResearchPortfolioProjectionFrontierDispositionRecordedEvent
	| AutoResearchPortfolioProjectionTerminalDecisionRecordedEvent
	| AutoResearchPortfolioProjectionLearningDecisionRecordedEvent
	| AutoResearchPortfolioProjectionBudgetUsageRecordedEvent
	| AutoResearchPortfolioProjectionEpochAdvancedEvent
	| AutoResearchPortfolioProjectionStatusChangedEvent;

export interface AutoResearchPortfolioProjectionResourceUsageInput {
	readonly wallMilliseconds?: number;
	readonly costMicrounits?: number;
	readonly tokens?: number;
}

type ProjectionEventInput<TEvent extends ProjectionEventBase> = Omit<
	TEvent,
	"schemaVersion" | "eventDigest" | "projectionId"
> & {
	readonly schemaVersion?: typeof AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION;
	readonly eventDigest?: string;
	readonly projectionId?: string;
};

export type AutoResearchPortfolioProjectionEventInput =
	| ProjectionEventInput<AutoResearchPortfolioProjectionCandidateRegisteredEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionImpactClosureRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionHostVectorMeasuredEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionOpaqueHoldoutAggregateRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionFrontierDispositionRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionTerminalDecisionRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionLearningDecisionRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionBudgetUsageRecordedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionEpochAdvancedEvent>
	| ProjectionEventInput<AutoResearchPortfolioProjectionStatusChangedEvent>;

const STATUS_RANK: Readonly<Record<AutoResearchPortfolioProjectionStatus, number>> = {
	active: 0,
	paused: 1,
	budget_limited: 2,
	blocked: 3,
	failed: 4,
	cancelled: 4,
	complete: 5,
};
const CANDIDATE_RANK: Readonly<Record<AutoResearchPortfolioProjectionCandidateLifecycle, number>> = {
	registered: 0,
	measured: 1,
	frontier_exploratory: 2,
	frontier_admitted: 2,
	frontier_discarded: 2,
	terminal_decided: 3,
	learning_decided: 4,
};
const EMPTY_USAGE: AutoResearchPortfolioProjectionResourceUsage = Object.freeze({
	candidates: 0,
	measurements: 0,
	wallMilliseconds: 0,
	costMicrounits: 0,
	tokens: 0,
});
const INPUT_KEYS = [
	"projectionId",
	"workflowId",
	"epochRef",
	"contract",
	"provenance",
	"receiptContext",
	"budget",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownDataKeys(value: object, label: string): string[] {
	const keys = Reflect.ownKeys(value);
	const names: string[] = [];
	for (const key of keys) {
		if (typeof key !== "string") throw new Error(`${label} contains a symbol field`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
			throw new Error(`${label} contains an accessor or non-enumerable field`);
		names.push(key);
	}
	return names;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
	ownDataKeys(value, label);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	assertRecord(value, label);
	const actual = ownDataKeys(value, label).sort(compareStrings);
	const required = [...expected].sort(compareStrings);
	if (JSON.stringify(actual) !== JSON.stringify(required)) {
		const unknown = actual.filter((key) => !required.includes(key));
		throw new Error(
			`${label} has ${unknown.length > 0 ? `unknown field(s): ${unknown.join(", ")}` : "an incomplete field set"}`,
		);
	}
}

function assertClosedArray(value: unknown, label: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		throw new Error(`${label} must use the standard array prototype`);
	const descriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (descriptor === undefined || !("value" in descriptor)) throw new Error(`${label} length must be a data property`);
	const length = descriptor.value as number;
	const keys = Reflect.ownKeys(value);
	let count = 0;
	for (const key of keys) {
		if (key === "length") continue;
		if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key))
			throw new Error(`${label} contains a hidden or out-of-range field`);
		const index = Number(key);
		const item = Object.getOwnPropertyDescriptor(value, key);
		if (
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= length ||
			item === undefined ||
			!item.enumerable ||
			!("value" in item)
		)
			throw new Error(`${label} contains an accessor or out-of-range field`);
		count += 1;
	}
	if (count !== length) throw new Error(`${label} must be dense`);
}

function assertSafeTree(value: unknown, label: string, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) throw new Error(`${label} contains a cycle`);
	seen.add(value);
	if (Array.isArray(value)) {
		assertClosedArray(value, label);
		for (let index = 0; index < value.length; index += 1) assertSafeTree(value[index], `${label}[${index}]`, seen);
	} else {
		assertRecord(value, label);
		for (const key of ownDataKeys(value, label)) assertSafeTree(value[key], `${label}.${key}`, seen);
	}
	seen.delete(value);
}

function assertDeepFrozen(value: unknown, label: string, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (!Object.isFrozen(value)) throw new Error(`${label} must be deeply frozen`);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) assertDeepFrozen(value[index], `${label}[${index}]`, seen);
	} else {
		const record = value as Record<string, unknown>;
		for (const key of ownDataKeys(record, label)) assertDeepFrozen(record[key], `${label}.${key}`, seen);
	}
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) deepFreeze(value[index], seen);
	} else {
		for (const key of Object.keys(value as Record<string, unknown>))
			deepFreeze((value as Record<string, unknown>)[key], seen);
	}
	return Object.freeze(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bounded identifier`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
		throw new Error(`${label} must be an ISO-8601 timestamp`);
}

function assertFiniteNonNegative(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error(`${label} must be finite and non-negative`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${label} must be a positive integer`);
}

function validateProvenance(value: unknown, label: string): AutoResearchPortfolioReadOnlyProvenance {
	assertRecord(value, label);
	assertExactKeys(value, ["kind", "source", "sourceDigest", "recordedAt"], label);
	if (value.kind !== "read_only_provenance") throw new Error(`${label}.kind must be read_only_provenance`);
	if (typeof value.source !== "string" || value.source.trim().length === 0)
		throw new Error(`${label}.source is required`);
	assertDigest(value.sourceDigest, `${label}.sourceDigest`);
	assertTimestamp(value.recordedAt, `${label}.recordedAt`);
	return deepFreeze({
		kind: "read_only_provenance",
		source: value.source,
		sourceDigest: value.sourceDigest,
		recordedAt: value.recordedAt,
	});
}

function validateEpochRef(value: unknown): WorkflowEpochRef {
	assertRecord(value, "epochRef");
	assertExactKeys(value, ["storeEpoch", "coordinatorEpoch"], "epochRef");
	assertPositiveInteger(value.storeEpoch, "epochRef.storeEpoch");
	assertPositiveInteger(value.coordinatorEpoch, "epochRef.coordinatorEpoch");
	return { storeEpoch: value.storeEpoch, coordinatorEpoch: value.coordinatorEpoch };
}

function validateBudget(value: unknown): AutoResearchPortfolioProjectionBudgetLimits {
	assertRecord(value, "budget");
	assertExactKeys(
		value,
		["maxCandidates", "maxMeasurements", "maxWallMilliseconds", "maxCostMicrounits", "maxTokens"].filter(
			(key) => value[key] !== undefined,
		),
		"budget",
	);
	const keys = ["maxCandidates", "maxMeasurements", "maxWallMilliseconds", "maxCostMicrounits", "maxTokens"] as const;
	for (const key of keys) if (value[key] !== undefined) assertFiniteNonNegative(value[key], `budget.${key}`);
	const maxCandidates = value.maxCandidates as number | undefined;
	const maxMeasurements = value.maxMeasurements as number | undefined;
	const maxWallMilliseconds = value.maxWallMilliseconds as number | undefined;
	const maxCostMicrounits = value.maxCostMicrounits as number | undefined;
	const maxTokens = value.maxTokens as number | undefined;
	return deepFreeze({
		...(maxCandidates === undefined ? {} : { maxCandidates }),
		...(maxMeasurements === undefined ? {} : { maxMeasurements }),
		...(maxWallMilliseconds === undefined ? {} : { maxWallMilliseconds }),
		...(maxCostMicrounits === undefined ? {} : { maxCostMicrounits }),
		...(maxTokens === undefined ? {} : { maxTokens }),
	});
}

function resolveBudget(
	contractBudget: AutoResearchPortfolioContract["budgets"],
	requestedBudget: AutoResearchPortfolioProjectionBudgetLimits | undefined,
): AutoResearchPortfolioProjectionResolvedBudgetLimits {
	const configured = {
		maxCandidates: contractBudget.maxCandidates,
		maxMeasurements: contractBudget.maxMeasurements,
		maxWallMilliseconds: contractBudget.maxWallSeconds * 1_000,
		maxCostMicrounits: contractBudget.maxCostMicrounits,
		maxTokens: contractBudget.maxTokens,
	};
	const bounded = (key: keyof AutoResearchPortfolioProjectionBudgetLimits): number =>
		Math.min(configured[key], requestedBudget?.[key] ?? configured[key]);
	return Object.freeze({
		maxCandidates: bounded("maxCandidates"),
		maxMeasurements: bounded("maxMeasurements"),
		maxWallMilliseconds: bounded("maxWallMilliseconds"),
		maxCostMicrounits: bounded("maxCostMicrounits"),
		maxTokens: bounded("maxTokens"),
	});
}

function validateReceipt(value: unknown, label: string): WorkflowVerifiedHostReceipt {
	assertSafeTree(value, label);
	assertRecord(value, label);
	const expected = [
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
	];
	if (value.capabilityBinding !== undefined) expected.push("capabilityBinding");
	assertExactKeys(value, expected, label);
	if (typeof value.receiptKind !== "string" || typeof value.oneUse !== "boolean")
		throw new Error(`${label} shape is invalid`);
	assertIdentifier(value.receiptId, `${label}.receiptId`);
	if (typeof value.issuerId !== "string" || value.issuerId.trim().length === 0)
		throw new Error(`${label}.issuerId is required`);
	assertIdentifier(value.workflowId, `${label}.workflowId`);
	assertDigest(value.bindingDigest, `${label}.bindingDigest`);
	assertDigest(value.payloadDigest, `${label}.payloadDigest`);
	assertTimestamp(value.issuedAt, `${label}.issuedAt`);
	assertTimestamp(value.validUntil, `${label}.validUntil`);
	assertIdentifier(value.keyId, `${label}.keyId`);
	if (value.signatureAlgorithm !== "ed25519") throw new Error(`${label}.signatureAlgorithm is invalid`);
	assertDigest(value.artifactBytesDigest, `${label}.artifactBytesDigest`);
	assertDigest(value.stateDigest, `${label}.stateDigest`);
	assertPositiveInteger(value.revision, `${label}.revision`);
	if (typeof value.signature !== "string" || value.signature.length === 0)
		throw new Error(`${label}.signature is required`);
	assertDigest(value.verificationDigest, `${label}.verificationDigest`);
	assertRecord(value.artifactRef, `${label}.artifactRef`);
	if (value.capabilityBinding !== undefined) {
		assertRecord(value.capabilityBinding, `${label}.capabilityBinding`);
		assertExactKeys(
			value.capabilityBinding,
			["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
			`${label}.capabilityBinding`,
		);
		if (value.capabilityBinding.capability !== CAPABILITY)
			throw new Error(`${label}.capabilityBinding capability is invalid`);
		assertDigest(value.capabilityBinding.resourceDigest, `${label}.capabilityBinding.resourceDigest`);
		assertDigest(value.capabilityBinding.operationDigest, `${label}.capabilityBinding.operationDigest`);
		if (
			value.capabilityBinding.executionIdentity !== null &&
			typeof value.capabilityBinding.executionIdentity !== "string"
		)
			throw new Error(`${label}.capabilityBinding.executionIdentity is invalid`);
		if (value.capabilityBinding.sessionId !== null && typeof value.capabilityBinding.sessionId !== "string")
			throw new Error(`${label}.capabilityBinding.sessionId is invalid`);
	}
	return deepFreeze(clone(value)) as unknown as WorkflowVerifiedHostReceipt;
}

function validateContext(context: unknown): asserts context is WorkflowHostReceiptConsumerContext {
	assertRecord(context, "receiptContext");
	const typedContext = context as unknown as WorkflowHostReceiptConsumerContext;
	if (typeof typedContext.principalAuthorizer?.authorize !== "function")
		throw new Error("CONTRACT_CHANGE: projection requires the generic host principalAuthorizer seam");
	if (
		typeof typedContext.receiptResolver?.resolve !== "function" ||
		typeof typedContext.keyResolver?.resolve !== "function" ||
		typeof typedContext.artifactResolver?.resolve !== "function"
	)
		throw new Error("receiptContext resolvers are required");
}

function validateInput(input: AutoResearchPortfolioProjectionInput): {
	readonly projectionId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly contract: AutoResearchPortfolioContract;
	readonly contractDigest: string;
	readonly provenance: AutoResearchPortfolioReadOnlyProvenance;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly budget?: AutoResearchPortfolioProjectionBudgetLimits;
} {
	assertRecord(input, "projection input");
	const definedInput = Object.fromEntries(
		ownDataKeys(input, "projection input")
			.filter((key) => input[key] !== undefined)
			.map((key) => [key, input[key]]),
	) as Record<string, unknown>;
	assertExactKeys(
		definedInput,
		INPUT_KEYS.filter((key) => input[key] !== undefined),
		"projection input",
	);
	assertIdentifier(input.projectionId, "projectionId");
	assertIdentifier(input.workflowId, "workflowId");
	const epochRef = validateEpochRef(input.epochRef);
	assertSafeTree(input.contract, "contract");
	const contract = parseAutoResearchPortfolioContract(clone(input.contract));
	const contractDigest = autoResearchPortfolioContractDigest(contract);
	const provenance = validateProvenance(input.provenance, "provenance");
	validateContext(input.receiptContext);
	const budget = input.budget === undefined ? undefined : validateBudget(input.budget);
	return {
		projectionId: input.projectionId,
		workflowId: input.workflowId,
		epochRef,
		contract,
		contractDigest,
		provenance,
		receiptContext: input.receiptContext,
		...(budget === undefined ? {} : { budget }),
	};
}

function eventKeys(kind: AutoResearchPortfolioProjectionEventKind): readonly string[] {
	const base = [
		"schemaVersion",
		"eventId",
		"eventDigest",
		"projectionId",
		"revision",
		"epoch",
		"occurredAt",
		"contractDigest",
		"provenance",
		"priorHead",
		"resourceDigest",
		"operationDigest",
		"hostReceipt",
		"kind",
	];
	const extra: Record<AutoResearchPortfolioProjectionEventKind, readonly string[]> = {
		candidate_registered: ["candidate", "candidateDigest"],
		impact_closure_recorded: ["candidateId", "candidateDigest", "impactClosure"],
		host_vector_measured: ["candidateId", "candidateDigest", "measurement"],
		opaque_holdout_aggregate_recorded: [
			"aggregateId",
			"goalId",
			"candidateId",
			"candidateDigest",
			"aggregateDigest",
			"evidenceDigest",
		],
		frontier_disposition_recorded: ["candidateId", "candidateDigest", "disposition", "frontierDigest"],
		terminal_decision_recorded: [
			"decisionId",
			"candidateId",
			"candidateDigest",
			"terminalEvaluation",
			"terminalEvidence",
			"evidenceDigest",
		],
		learning_decision_recorded: [
			"decisionId",
			"candidateId",
			"candidateDigest",
			"scope",
			"disposition",
			"evidenceDigest",
		],
		budget_usage_recorded: ["usage"],
		epoch_advanced: ["fromEpoch"],
		status_changed: ["status", "reason"],
	};
	return [...base, ...extra[kind]];
}

function eventPayload(event: Record<string, unknown>): Record<string, unknown> {
	const payload = { ...event };
	delete payload.eventDigest;
	return payload;
}

function authorizationPayload(event: Record<string, unknown>): Record<string, unknown> {
	const payload = eventPayload(event);
	delete payload.hostReceipt;
	return payload;
}

/** Compute the generic host-capability binding for one projection event. */

export function autoResearchPortfolioProjectionEventBindingDigest(
	event: Record<string, unknown>,
	workflowIdOverride?: string,
): string {
	const canonicalEvent = canonicalizeEventBody(event);
	return digestObject({
		workflowId: workflowIdOverride ?? canonicalEvent.workflowId,
		projectionId: canonicalEvent.projectionId,
		eventId: canonicalEvent.eventId,
		revision: canonicalEvent.revision,
		epoch: canonicalEvent.epoch,
		contractDigest: canonicalEvent.contractDigest,
		priorHead: canonicalEvent.priorHead,
		payloadDigest: digestObject(authorizationPayload(canonicalEvent)),
	});
}

function expectedResourceDigest(projectionId: string, contractDigest: string): string {
	return digestObject({ kind: "portfolio_projection.resource.v1", projectionId, contractDigest });
}

function expectedOperationDigest(eventId: string, eventKind: string, contractDigest: string): string {
	return digestObject({ kind: "portfolio_projection.operation.v1", eventId, eventKind, contractDigest });
}

function validateDigestList(value: unknown, label: string): readonly string[] {
	assertClosedArray(value, label);
	const result: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		assertDigest(value[index], `${label}[${index}]`);
		result.push(value[index] as string);
	}
	return result;
}

function validateCommitIntent(value: unknown): PortfolioTerminalCommitIntent | null {
	if (value === null) return null;
	assertRecord(value, "terminalEvaluation.commitIntent");
	assertExactKeys(
		value,
		[
			"capability",
			"outcome",
			"receiptIds",
			"bindingDigests",
			"resourceDigests",
			"operationDigests",
			"workflowId",
			"currentStateDigest",
			"currentRevision",
			"evaluationEpoch",
			"witnessRequired",
		],
		"terminalEvaluation.commitIntent",
	);
	if (value.capability !== "portfolio_default_completion" || value.witnessRequired !== true)
		throw new Error("terminalEvaluation commit intent is invalid");
	if (!PORTFOLIO_TERMINAL_OUTCOMES.includes(value.outcome as PortfolioTerminalEvaluation["outcome"]))
		throw new Error("terminalEvaluation commit intent outcome is invalid");
	assertIdentifier(value.workflowId, "terminalEvaluation.commitIntent.workflowId");
	assertDigest(value.currentStateDigest, "terminalEvaluation.commitIntent.currentStateDigest");
	assertPositiveInteger(value.currentRevision, "terminalEvaluation.commitIntent.currentRevision");
	assertPositiveInteger(value.evaluationEpoch, "terminalEvaluation.commitIntent.evaluationEpoch");
	const receiptIds = sortedStrings(value.receiptIds, "terminalEvaluation.commitIntent.receiptIds");
	for (let index = 0; index < receiptIds.length; index += 1)
		assertIdentifier(receiptIds[index], `terminalEvaluation.commitIntent.receiptIds[${index}]`);
	const bindingDigests = validateDigestList(value.bindingDigests, "terminalEvaluation.commitIntent.bindingDigests");
	const resourceDigests = validateDigestList(value.resourceDigests, "terminalEvaluation.commitIntent.resourceDigests");
	const operationDigests = validateDigestList(
		value.operationDigests,
		"terminalEvaluation.commitIntent.operationDigests",
	);
	for (const [label, digests] of [
		["bindingDigests", bindingDigests],
		["resourceDigests", resourceDigests],
		["operationDigests", operationDigests],
	] as const) {
		if (digests.length !== receiptIds.length)
			throw new Error(`terminalEvaluation.commitIntent.${label} length is not bound to receiptIds`);
		for (let index = 0; index < digests.length; index += 1)
			assertDigest(digests[index], `terminalEvaluation.commitIntent.${label}[${index}]`);
	}
	return deepFreeze({
		capability: "portfolio_default_completion",
		outcome: value.outcome as PortfolioTerminalEvaluation["outcome"],
		receiptIds: [...receiptIds],
		bindingDigests: [...bindingDigests],
		resourceDigests: [...resourceDigests],
		operationDigests: [...operationDigests],
		workflowId: value.workflowId,
		currentStateDigest: value.currentStateDigest,
		currentRevision: value.currentRevision,
		evaluationEpoch: value.evaluationEpoch,
		witnessRequired: true,
	});
}

function validateTerminalEvaluation(value: unknown, contractDigest: string): PortfolioTerminalEvaluation {
	assertRecord(value, "terminalEvaluation");
	assertExactKeys(
		value,
		[
			"accepted",
			"outcome",
			"goalDispositions",
			"requiredGoalIds",
			"unresolvedGoalIds",
			"selectedFrontierEntryIds",
			"reasons",
			"authority",
			"workerCanAuthorize",
			"candidateCanAuthorize",
			"mutated",
			"evaluationDigest",
			...(value.commitIntent === undefined ? [] : ["commitIntent"]),
		],
		"terminalEvaluation",
	);
	if (
		typeof value.accepted !== "boolean" ||
		!PORTFOLIO_TERMINAL_OUTCOMES.includes(value.outcome as PortfolioTerminalEvaluation["outcome"])
	)
		throw new Error("terminalEvaluation shape is invalid");
	const outcome = value.outcome as PortfolioTerminalEvaluation["outcome"];
	if (
		value.authority !== "host" ||
		value.workerCanAuthorize !== false ||
		value.candidateCanAuthorize !== false ||
		value.mutated !== false
	)
		throw new Error("terminalEvaluation authority is not host-only");
	assertClosedArray(value.goalDispositions, "terminalEvaluation.goalDispositions");
	const goalDispositions: { goalId: string; disposition: PortfolioGoalDisposition }[] = [];
	for (let index = 0; index < value.goalDispositions.length; index += 1) {
		const entry = value.goalDispositions[index];
		assertRecord(entry, `terminalEvaluation.goalDispositions[${index}]`);
		assertExactKeys(entry, ["goalId", "disposition"], `terminalEvaluation.goalDispositions[${index}]`);
		assertIdentifier(entry.goalId, `terminalEvaluation.goalDispositions[${index}].goalId`);
		if (!PORTFOLIO_GOAL_DISPOSITIONS.includes(entry.disposition as PortfolioGoalDisposition))
			throw new Error("terminalEvaluation disposition is invalid");
		goalDispositions.push({ goalId: entry.goalId, disposition: entry.disposition as PortfolioGoalDisposition });
	}
	const sortedGoalIds = goalDispositions.map((entry) => entry.goalId).sort(compareStrings);
	if (
		JSON.stringify(sortedGoalIds) !== JSON.stringify(goalDispositions.map((entry) => entry.goalId)) ||
		new Set(sortedGoalIds).size !== sortedGoalIds.length
	)
		throw new Error("terminalEvaluation goals are not canonical");
	const requiredGoalIds = sortedStrings(value.requiredGoalIds, "terminalEvaluation.requiredGoalIds");
	if (JSON.stringify(requiredGoalIds) !== JSON.stringify(sortedGoalIds))
		throw new Error("terminalEvaluation required goals changed");
	const unresolvedGoalIds = sortedStrings(value.unresolvedGoalIds, "terminalEvaluation.unresolvedGoalIds");
	const expectedUnresolved = goalDispositions
		.filter((entry) => entry.disposition !== "achieved")
		.map((entry) => entry.goalId);
	if (JSON.stringify(unresolvedGoalIds) !== JSON.stringify(expectedUnresolved))
		throw new Error("terminalEvaluation unresolved goals changed");
	if (value.accepted && (requiredGoalIds.length === 0 || unresolvedGoalIds.length > 0))
		throw new Error("accepted terminalEvaluation is incomplete");
	const selectedFrontierEntryIds = sortedStrings(
		value.selectedFrontierEntryIds,
		"terminalEvaluation.selectedFrontierEntryIds",
	);
	const reasons = sortedStrings(value.reasons, "terminalEvaluation.reasons");
	assertDigest(value.evaluationDigest, "terminalEvaluation.evaluationDigest");
	const expectedDigest = digestObject({
		contractDigest,
		outcome,
		goalDispositions,
		selectedFrontierEntryIds,
		reasons,
	});
	if (value.evaluationDigest !== expectedDigest) throw new Error("terminalEvaluation digest is not canonical");
	const commitIntent = value.commitIntent === undefined ? undefined : validateCommitIntent(value.commitIntent);
	return deepFreeze({
		accepted: value.accepted,
		outcome,
		goalDispositions: deepFreeze(goalDispositions),
		requiredGoalIds: [...requiredGoalIds],
		unresolvedGoalIds: [...unresolvedGoalIds],
		selectedFrontierEntryIds: [...selectedFrontierEntryIds],
		reasons: [...reasons],
		authority: "host",
		workerCanAuthorize: false,
		candidateCanAuthorize: false,
		mutated: false,
		evaluationDigest: value.evaluationDigest,
		...(commitIntent === undefined ? {} : { commitIntent }),
	});
}

function sortedStrings(value: unknown, label: string): readonly string[] {
	assertClosedArray(value, label);
	const result: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (typeof value[index] !== "string") throw new Error(`${label} must contain strings`);
		result.push(value[index] as string);
	}
	const sorted = [...result].sort(compareStrings);
	if (JSON.stringify(sorted) !== JSON.stringify(result) || new Set(result).size !== result.length)
		throw new Error(`${label} must be canonicalized and unique`);
	return result;
}

function validateUsage(value: unknown): AutoResearchPortfolioProjectionResourceUsageInput {
	assertRecord(value, "usage");
	assertExactKeys(value, Object.keys(value), "usage");
	const allowed = ["wallMilliseconds", "costMicrounits", "tokens"];
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`usage has unknown field ${key}`);
		assertFiniteNonNegative(value[key], `usage.${key}`);
	}
	return deepFreeze(clone(value) as AutoResearchPortfolioProjectionResourceUsageInput);
}

function validateClosure(value: unknown): AutoResearchPortfolioImpactClosure {
	assertRecord(value, "impactClosure");
	assertExactKeys(
		value,
		[
			"authority",
			"derivationVersion",
			"directGoalIds",
			"transitiveGoalIds",
			"affectedPartitionIds",
			"affectedInvariantIds",
			"sourceDigest",
			"closureDigest",
			"intendedGoalIds",
			"dependentGoalIds",
			"competingGoalIds",
			"conflictRelatedGoalIds",
			"structurallyAffectedGoalIds",
			"goalIds",
			"metricIds",
			"impactClosureDigest",
		],
		"impactClosure",
	);
	if (value.authority !== "host_derived") throw new Error("impactClosure authority is invalid");
	assertPositiveInteger(value.derivationVersion, "impactClosure.derivationVersion");
	for (const key of [
		"directGoalIds",
		"transitiveGoalIds",
		"affectedPartitionIds",
		"affectedInvariantIds",
		"intendedGoalIds",
		"dependentGoalIds",
		"competingGoalIds",
		"conflictRelatedGoalIds",
		"structurallyAffectedGoalIds",
		"goalIds",
		"metricIds",
	] as const)
		sortedStrings(value[key], `impactClosure.${key}`);
	assertDigest(value.sourceDigest, "impactClosure.sourceDigest");
	assertDigest(value.closureDigest, "impactClosure.closureDigest");
	assertDigest(value.impactClosureDigest, "impactClosure.impactClosureDigest");
	if (
		value.closureDigest !==
		digestObject({ sourceDigest: value.sourceDigest, goalIds: value.goalIds, metricIds: value.metricIds })
	)
		throw new Error("impactClosure closureDigest is not canonical");
	if (
		value.impactClosureDigest !==
		digestObject({
			authority: "host_derived",
			derivationVersion: value.derivationVersion,
			sourceDigest: value.sourceDigest,
			closureDigest: value.closureDigest,
			intendedGoalIds: value.intendedGoalIds,
			dependentGoalIds: value.dependentGoalIds,
			competingGoalIds: value.competingGoalIds,
			conflictRelatedGoalIds: value.conflictRelatedGoalIds,
			structurallyAffectedGoalIds: value.structurallyAffectedGoalIds,
			goalIds: value.goalIds,
			metricIds: value.metricIds,
		})
	)
		throw new Error("impactClosure impactClosureDigest is not canonical");
	return deepFreeze(clone(value)) as unknown as AutoResearchPortfolioImpactClosure;
}

function canonicalizeEventBody(rawEvent: Record<string, unknown>): Record<string, unknown> {
	assertSafeTree(rawEvent, "projection event");
	const event = clone(rawEvent) as unknown as Record<string, unknown>;
	if (!EVENT_KINDS.includes(event.kind as AutoResearchPortfolioProjectionEventKind))
		throw new Error("projection event kind is not closed");
	const kind = event.kind as AutoResearchPortfolioProjectionEventKind;
	if (kind === "candidate_registered") event.candidate = parseAutoResearchPortfolioCandidate(clone(event.candidate));
	if (kind === "impact_closure_recorded") event.impactClosure = validateClosure(event.impactClosure);
	if (kind === "host_vector_measured")
		event.measurement = parseAutoResearchPortfolioMeasurement(clone(event.measurement));
	if (kind === "terminal_decision_recorded")
		event.terminalEvaluation = validateTerminalEvaluation(event.terminalEvaluation, String(event.contractDigest));
	if (kind === "budget_usage_recorded") event.usage = validateUsage(event.usage);
	return event;
}

function validateTerminalEvidenceShape(value: unknown): void {
	assertRecord(value, "terminalEvidence");
	assertExactKeys(
		value,
		[
			"measurements",
			"frontier",
			"boundaries",
			"acquisition",
			"completion",
			"tradeoff",
			"infeasibility",
			"goalDecisions",
			"stop",
		],
		"terminalEvidence",
	);
	assertClosedArray(value.measurements, "terminalEvidence.measurements");
	assertRecord(value.frontier, "terminalEvidence.frontier");
	assertExactKeys(value.frontier, ["entries", "selectedEntryIds", "receipt"], "terminalEvidence.frontier");
	assertClosedArray(value.frontier.entries, "terminalEvidence.frontier.entries");
	assertClosedArray(value.frontier.selectedEntryIds, "terminalEvidence.frontier.selectedEntryIds");
	assertClosedArray(value.boundaries, "terminalEvidence.boundaries");
	assertRecord(value.acquisition, "terminalEvidence.acquisition");
	assertExactKeys(value.acquisition, ["splits"], "terminalEvidence.acquisition");
	assertClosedArray(value.acquisition.splits, "terminalEvidence.acquisition.splits");
	assertRecord(value.completion, "terminalEvidence.completion");
	assertClosedArray(value.completion.artifacts, "terminalEvidence.completion.artifacts");
	if (value.tradeoff !== null) assertRecord(value.tradeoff, "terminalEvidence.tradeoff");
	assertClosedArray(value.infeasibility, "terminalEvidence.infeasibility");
	assertClosedArray(value.goalDecisions, "terminalEvidence.goalDecisions");
	if (value.stop !== null) assertRecord(value.stop, "terminalEvidence.stop");
}

function validateEvent(rawEvent: unknown): AutoResearchPortfolioProjectionEvent {
	assertSafeTree(rawEvent, "projection event");
	return validateEventMutable(clone(rawEvent));
}

function validateEventMutable(rawEvent: unknown): AutoResearchPortfolioProjectionEvent {
	assertRecord(rawEvent, "projection event");
	if (!EVENT_KINDS.includes(rawEvent.kind as AutoResearchPortfolioProjectionEventKind))
		throw new Error("projection event kind is not closed");
	const kind = rawEvent.kind as AutoResearchPortfolioProjectionEventKind;
	assertExactKeys(rawEvent, eventKeys(kind), `projection event ${kind}`);
	if (rawEvent.schemaVersion !== AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION)
		throw new Error("projection event schema version is unsupported");
	assertIdentifier(rawEvent.eventId, "projection event eventId");
	assertDigest(rawEvent.eventDigest, "projection event eventDigest");
	assertIdentifier(rawEvent.projectionId, "projection event projectionId");
	assertPositiveInteger(rawEvent.revision, "projection event revision");
	assertPositiveInteger(rawEvent.epoch, "projection event epoch");
	assertTimestamp(rawEvent.occurredAt, "projection event occurredAt");
	assertDigest(rawEvent.contractDigest, "projection event contractDigest");
	validateProvenance(rawEvent.provenance, "projection event provenance");
	if (rawEvent.priorHead !== null) assertDigest(rawEvent.priorHead, "projection event priorHead");
	assertDigest(rawEvent.resourceDigest, "projection event resourceDigest");
	assertDigest(rawEvent.operationDigest, "projection event operationDigest");
	validateReceipt(rawEvent.hostReceipt, "projection event hostReceipt");
	if (rawEvent.resourceDigest !== expectedResourceDigest(rawEvent.projectionId, rawEvent.contractDigest))
		throw new Error("projection event resource binding changed");
	if (rawEvent.operationDigest !== expectedOperationDigest(rawEvent.eventId, kind, rawEvent.contractDigest))
		throw new Error("projection event operation binding changed");
	if (kind === "candidate_registered") {
		assertSafeTree(rawEvent.candidate, "candidate");
		const candidate = parseAutoResearchPortfolioCandidate(clone(rawEvent.candidate));
		assertDigest(rawEvent.candidateDigest, "candidateDigest");
		if (rawEvent.candidateDigest !== autoResearchPortfolioCandidateDigest(candidate))
			throw new Error("candidateDigest is not canonical");
		(rawEvent as Record<string, unknown>).candidate = candidate;
	}
	if (kind === "impact_closure_recorded") {
		assertIdentifier(rawEvent.candidateId, "candidateId");
		assertDigest(rawEvent.candidateDigest, "candidateDigest");
		(rawEvent as Record<string, unknown>).impactClosure = validateClosure(rawEvent.impactClosure);
	}
	if (kind === "host_vector_measured") {
		if (rawEvent.candidateId !== null) assertIdentifier(rawEvent.candidateId, "candidateId");
		if (rawEvent.candidateDigest !== null) assertDigest(rawEvent.candidateDigest, "candidateDigest");
		const measurement = parseAutoResearchPortfolioMeasurement(clone(rawEvent.measurement));
		if (measurement.kind === "holdout") throw new Error("raw holdout vectors are not accepted");
		if (measurement.candidateId !== rawEvent.candidateId) throw new Error("measurement candidate binding changed");
		(rawEvent as Record<string, unknown>).measurement = measurement;
	}
	if (kind === "opaque_holdout_aggregate_recorded") {
		assertIdentifier(rawEvent.aggregateId, "aggregateId");
		assertIdentifier(rawEvent.goalId, "goalId");
		if (rawEvent.candidateId !== null) assertIdentifier(rawEvent.candidateId, "candidateId");
		if (rawEvent.candidateDigest !== null) assertDigest(rawEvent.candidateDigest, "candidateDigest");
		assertDigest(rawEvent.aggregateDigest, "aggregateDigest");
		assertDigest(rawEvent.evidenceDigest, "evidenceDigest");
		const expected = digestObject({
			aggregateId: rawEvent.aggregateId,
			goalId: rawEvent.goalId,
			candidateId: rawEvent.candidateId,
			candidateDigest: rawEvent.candidateDigest,
			evidenceDigest: rawEvent.evidenceDigest,
		});
		if (rawEvent.aggregateDigest !== expected) throw new Error("aggregateDigest is not canonical");
	}
	if (kind === "frontier_disposition_recorded") {
		assertIdentifier(rawEvent.candidateId, "candidateId");
		assertDigest(rawEvent.candidateDigest, "candidateDigest");
		if (!FRONTIER_DISPOSITIONS.includes(rawEvent.disposition as AutoResearchPortfolioProjectionFrontierDisposition))
			throw new Error("frontier disposition is invalid");
		assertDigest(rawEvent.frontierDigest, "frontierDigest");
		const expected = digestObject({
			contractDigest: rawEvent.contractDigest,
			candidateId: rawEvent.candidateId,
			candidateDigest: rawEvent.candidateDigest,
			disposition: rawEvent.disposition,
		});
		if (rawEvent.frontierDigest !== expected) throw new Error("frontierDigest is not canonical");
	}
	if (kind === "terminal_decision_recorded") {
		assertIdentifier(rawEvent.decisionId, "decisionId");
		if (rawEvent.candidateId !== null) assertIdentifier(rawEvent.candidateId, "candidateId");
		if (rawEvent.candidateDigest !== null) assertDigest(rawEvent.candidateDigest, "candidateDigest");
		(rawEvent as Record<string, unknown>).terminalEvaluation = validateTerminalEvaluation(
			rawEvent.terminalEvaluation,
			rawEvent.contractDigest,
		);
		assertSafeTree(rawEvent.terminalEvidence, "terminalEvidence");
		validateTerminalEvidenceShape(rawEvent.terminalEvidence);
		assertDigest(rawEvent.evidenceDigest, "evidenceDigest");
		if (rawEvent.evidenceDigest !== digestObject(rawEvent.terminalEvidence))
			throw new Error("terminal evidence digest changed");
	}
	if (kind === "learning_decision_recorded") {
		assertIdentifier(rawEvent.decisionId, "decisionId");
		if (rawEvent.candidateId !== null) assertIdentifier(rawEvent.candidateId, "candidateId");
		if (rawEvent.candidateDigest !== null) assertDigest(rawEvent.candidateDigest, "candidateDigest");
		if (
			!LEARNING_SCOPES.includes(rawEvent.scope as AutoResearchPortfolioProjectionLearningScope) ||
			!LEARNING_DISPOSITIONS.includes(rawEvent.disposition as AutoResearchPortfolioProjectionLearningDisposition)
		)
			throw new Error("learning decision is invalid");
		assertDigest(rawEvent.evidenceDigest, "evidenceDigest");
		const expected = digestObject({
			contractDigest: rawEvent.contractDigest,
			candidateId: rawEvent.candidateId,
			candidateDigest: rawEvent.candidateDigest,
			decisionId: rawEvent.decisionId,
			scope: rawEvent.scope,
			disposition: rawEvent.disposition,
		});
		if (rawEvent.evidenceDigest !== expected) throw new Error("learning evidence binding changed");
	}
	if (kind === "budget_usage_recorded") (rawEvent as Record<string, unknown>).usage = validateUsage(rawEvent.usage);
	if (kind === "epoch_advanced") assertPositiveInteger(rawEvent.fromEpoch, "fromEpoch");
	if (kind === "status_changed") {
		if (!STATUSES.includes(rawEvent.status as AutoResearchPortfolioProjectionStatus))
			throw new Error("projection status is invalid");
		if (typeof rawEvent.reason !== "string" || rawEvent.reason.trim().length === 0)
			throw new Error("status reason is required");
	}
	const eventDigest = digestObject(eventPayload(rawEvent));
	if (rawEvent.eventDigest !== eventDigest) throw new Error("projection event digest does not match canonical bytes");
	return deepFreeze(clone(rawEvent)) as unknown as AutoResearchPortfolioProjectionEvent;
}

/** Create an event whose digest covers canonical evidence and its host-capability receipt. */
export function createAutoResearchPortfolioProjectionEvent(
	input: AutoResearchPortfolioProjectionEventInput,
): AutoResearchPortfolioProjectionEvent {
	assertSafeTree(input, "projection event input");
	assertRecord(input, "projection event input");
	const body = {
		...input,
		schemaVersion: input.schemaVersion ?? AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION,
		projectionId: input.projectionId ?? "projection-unknown",
	};
	const canonicalBody = canonicalizeEventBody(body);
	const eventDigest = digestObject(eventPayload(canonicalBody));
	if (input.eventDigest !== undefined && input.eventDigest !== eventDigest)
		throw new Error("projection event digest does not match canonical bytes");
	return validateEvent({ ...canonicalBody, eventDigest });
}

function digestProjectionState(state: Omit<AutoResearchPortfolioProjectionState, "projectionDigest">): string {
	return digestObject(state);
}

function initialState(input: AutoResearchPortfolioProjectionInput): AutoResearchPortfolioProjectionState {
	const checked = validateInput(input);
	const stateWithoutDigest: Omit<AutoResearchPortfolioProjectionState, "projectionDigest"> = {
		schemaVersion: AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION,
		projectionId: checked.projectionId,
		workflowId: checked.workflowId,
		epochRef: checked.epochRef,
		contractDigest: checked.contractDigest,
		contract: checked.contract,
		revision: 0,
		head: null,
		epoch: 1,
		provenance: checked.provenance,
		authority: null,
		status: "active",
		statusReason: null,
		candidates: [],
		impactClosures: [],
		measurements: [],
		frontier: [],
		terminalDecisions: [],
		learningDecisions: [],
		holdoutAggregates: [],
		budgetLimits: resolveBudget(checked.contract.budgets, checked.budget),
		budgetUsage: EMPTY_USAGE,
		appliedEventIds: [],
		appliedEventDigests: [],
		appliedEvents: [],
	};
	return deepFreeze({ ...stateWithoutDigest, projectionDigest: digestProjectionState(stateWithoutDigest) });
}

/** Create an immutable empty projection bound to one parsed schema-v3 contract. */
export function createAutoResearchPortfolioProjection(
	input: AutoResearchPortfolioProjectionInput,
): AutoResearchPortfolioProjectionState {
	return initialState(input);
}

function sortedById<T>(values: readonly T[], key: keyof T): readonly T[] {
	return [...values].sort((left, right) => compareStrings(String(left[key]), String(right[key])));
}

function candidateFor(
	state: AutoResearchPortfolioProjectionState,
	candidateId: string,
): AutoResearchPortfolioProjectionCandidate {
	for (let index = 0; index < state.candidates.length; index += 1)
		if (state.candidates[index]!.candidateId === candidateId) return state.candidates[index]!;
	throw new Error(`projection references unknown candidate ${candidateId}`);
}

function candidateContractValue(candidate: AutoResearchPortfolioProjectionCandidate): AutoResearchPortfolioCandidate {
	return {
		candidateId: candidate.candidateId,
		goalIds: candidate.goalIds,
		solutionFamily: candidate.solutionFamily,
		ancestry: candidate.ancestry,
		causalMechanism: candidate.causalMechanism,
		change: candidate.change,
		scope: candidate.scope,
	};
}

function goalFor(state: AutoResearchPortfolioProjectionState, goalId: string) {
	for (let index = 0; index < state.contract.goals.length; index += 1)
		if (state.contract.goals[index]!.goalId === goalId) return state.contract.goals[index]!;
	throw new Error(`projection references unknown contract goal ${goalId}`);
}

function replaceCandidate(
	state: AutoResearchPortfolioProjectionState,
	replacement: AutoResearchPortfolioProjectionCandidate,
): readonly AutoResearchPortfolioProjectionCandidate[] {
	return sortedById(
		state.candidates.map((entry) => (entry.candidateId === replacement.candidateId ? replacement : entry)),
		"candidateId",
	);
}

function lifecycleAtLeast(
	candidate: AutoResearchPortfolioProjectionCandidate,
	lifecycle: AutoResearchPortfolioProjectionCandidateLifecycle,
): boolean {
	return CANDIDATE_RANK[candidate.lifecycle] >= CANDIDATE_RANK[lifecycle];
}

function resolvedUsage(
	state: AutoResearchPortfolioProjectionState,
	scalar: AutoResearchPortfolioProjectionResourceUsage,
): AutoResearchPortfolioProjectionResourceUsage {
	return {
		candidates: state.candidates.length,
		measurements: state.measurements.length + state.holdoutAggregates.length,
		wallMilliseconds: scalar.wallMilliseconds,
		costMicrounits: scalar.costMicrounits,
		tokens: scalar.tokens,
	};
}

function assertWithinBudget(
	limits: AutoResearchPortfolioProjectionResolvedBudgetLimits,
	usage: AutoResearchPortfolioProjectionResourceUsage,
): void {
	const checks: readonly [
		keyof AutoResearchPortfolioProjectionResolvedBudgetLimits,
		keyof AutoResearchPortfolioProjectionResourceUsage,
	][] = [
		["maxCandidates", "candidates"],
		["maxMeasurements", "measurements"],
		["maxWallMilliseconds", "wallMilliseconds"],
		["maxCostMicrounits", "costMicrounits"],
		["maxTokens", "tokens"],
	];
	for (const [limitKey, usageKey] of checks) {
		const limit = limits[limitKey];
		if (limit !== null && usage[usageKey] > limit)
			throw new Error(`projection budget ${String(usageKey)} limit exceeded`);
	}
}

function addUsage(left: number, right: number, label: string): number {
	const total = left + right;
	if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${label} exceeds safe resource range`);
	return total;
}

function assertCandidateContractBinding(
	state: AutoResearchPortfolioProjectionState,
	candidate: AutoResearchPortfolioCandidate,
): void {
	for (let index = 0; index < candidate.goalIds.length; index += 1) goalFor(state, candidate.goalIds[index]!);
	if (candidate.scope !== "terminal") throw new Error("projection candidate scope is not terminal-bound");
}

function applyCandidateRegistration(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionCandidateRegisteredEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	const existing = state.candidates.find((entry) => entry.candidateId === event.candidate.candidateId);
	if (existing !== undefined) {
		if (existing.candidateDigest !== event.candidateDigest) throw new Error("candidate registration conflicts");
		return {};
	}
	assertCandidateContractBinding(state, event.candidate);
	assertWithinBudget(
		state.budgetLimits,
		resolvedUsage(state, { ...state.budgetUsage, candidates: state.candidates.length + 1 }),
	);
	return {
		candidates: sortedById(
			[
				...state.candidates,
				{
					...event.candidate,
					candidateDigest: event.candidateDigest,
					lifecycle: "registered",
					measurementIds: [],
					impactClosureDigest: null,
					frontierDisposition: null,
					terminalDecisionId: null,
					learningDecisionId: null,
				},
			],
			"candidateId",
		),
	};
}

function applyClosure(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionImpactClosureRecordedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	const candidate = candidateFor(state, event.candidateId);
	if (candidate.candidateDigest !== event.candidateDigest) throw new Error("impact closure candidate binding changed");
	if (lifecycleAtLeast(candidate, "frontier_exploratory")) throw new Error("impact closure is not monotonic");
	const closure = validateClosure(event.impactClosure);
	const expectedClosure = deriveAutoResearchPortfolioImpactClosure(state.contract, candidateContractValue(candidate));
	if (digestObject(expectedClosure) !== digestObject(closure))
		throw new Error("impact closure is not derived from the parsed contract and candidate");
	for (const goalId of closure.directGoalIds) goalFor(state, goalId);
	for (const goalId of closure.transitiveGoalIds) goalFor(state, goalId);
	const existing = state.impactClosures.find((entry) => entry.candidateId === event.candidateId);
	if (existing !== undefined) {
		if (existing.closureDigest !== closure.closureDigest || existing.candidateDigest !== event.candidateDigest)
			throw new Error("impact closure conflicts");
		return {};
	}
	return {
		candidates: replaceCandidate(state, { ...candidate, impactClosureDigest: closure.closureDigest }),
		impactClosures: sortedById(
			[
				...state.impactClosures,
				{
					candidateId: event.candidateId,
					candidateDigest: event.candidateDigest,
					impactClosure: closure,
					closureDigest: closure.closureDigest,
				},
			],
			"candidateId",
		),
	};
}

function applyMeasurement(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionHostVectorMeasuredEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	const measurement = event.measurement;
	if (measurement.kind === "holdout") throw new Error("raw holdout vectors are not accepted");
	const goal = goalFor(state, measurement.goalId);
	parseAutoResearchPortfolioMeasurement(clone(measurement), {
		confidenceLevel: goal.uncertainty.confidence,
		evaluationEpoch: state.contract.inputManifest.evaluationEpoch,
		inputManifestDigest: state.contract.inputManifest.manifestDigest,
		splitClosureRoots: state.contract.inputManifest.splitClosureRoots,
	});
	const existing = state.measurements.find((entry) => entry.measurementId === measurement.measurementId);
	if (existing !== undefined) {
		if (existing.measurementDigest !== measurement.measurementDigest) throw new Error("measurement conflicts");
		return {};
	}
	let candidates = state.candidates;
	if (event.candidateId !== null) {
		const candidate = candidateFor(state, event.candidateId);
		if (event.candidateDigest !== candidate.candidateDigest || measurement.candidateId !== event.candidateId)
			throw new Error("measurement candidate binding changed");
		if (lifecycleAtLeast(candidate, "frontier_exploratory")) throw new Error("measurement is not monotonic");
		candidates = replaceCandidate(state, {
			...candidate,
			lifecycle: lifecycleAtLeast(candidate, "measured") ? candidate.lifecycle : "measured",
			measurementIds: [...candidate.measurementIds, measurement.measurementId].sort(compareStrings),
		});
	} else if (event.candidateDigest !== null)
		throw new Error("null measurement candidate cannot carry a candidate digest");
	const usage = resolvedUsage({ ...state, candidates } as AutoResearchPortfolioProjectionState, state.budgetUsage);
	assertWithinBudget(state.budgetLimits, {
		...usage,
		measurements: state.measurements.length + state.holdoutAggregates.length + 1,
	});
	return { candidates, measurements: sortedById([...state.measurements, measurement], "measurementId") };
}

function applyHoldout(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionOpaqueHoldoutAggregateRecordedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	let candidateDigest: string | null = null;
	if (event.candidateId !== null) {
		const candidate = candidateFor(state, event.candidateId);
		if (event.candidateDigest !== candidate.candidateDigest) throw new Error("holdout candidate binding changed");
		candidateDigest = candidate.candidateDigest;
	} else if (event.candidateDigest !== null) throw new Error("null holdout cannot carry a candidate digest");
	const existing = state.holdoutAggregates.find((entry) => entry.aggregateId === event.aggregateId);
	if (existing !== undefined) {
		if (existing.aggregateDigest !== event.aggregateDigest) throw new Error("holdout aggregate conflicts");
		return {};
	}
	goalFor(state, event.goalId);
	assertWithinBudget(
		state.budgetLimits,
		resolvedUsage(state, {
			...state.budgetUsage,
			measurements: state.measurements.length + state.holdoutAggregates.length + 1,
		}),
	);
	return {
		holdoutAggregates: sortedById(
			[
				...state.holdoutAggregates,
				{
					aggregateId: event.aggregateId,
					goalId: event.goalId,
					candidateId: event.candidateId,
					candidateDigest,
					aggregateDigest: event.aggregateDigest,
					evidenceDigest: event.evidenceDigest,
				},
			],
			"aggregateId",
		),
	};
}

function applyFrontier(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionFrontierDispositionRecordedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	const candidate = candidateFor(state, event.candidateId);
	if (candidate.candidateDigest !== event.candidateDigest) throw new Error("frontier candidate binding changed");
	if (lifecycleAtLeast(candidate, "terminal_decided")) throw new Error("frontier is not monotonic");
	if (!state.impactClosures.some((entry) => entry.candidateId === event.candidateId))
		throw new Error("frontier lacks a host-derived impact closure");
	const existing = state.frontier.find((entry) => entry.candidateId === event.candidateId);
	if (existing !== undefined) {
		if (existing.disposition !== event.disposition || existing.frontierDigest !== event.frontierDigest)
			throw new Error("frontier disposition conflicts");
		return {};
	}
	const lifecycle =
		event.disposition === "admitted" || event.disposition === "retained"
			? "frontier_admitted"
			: event.disposition === "exploratory"
				? "frontier_exploratory"
				: "frontier_discarded";
	return {
		candidates: replaceCandidate(state, { ...candidate, lifecycle, frontierDisposition: event.disposition }),
		frontier: sortedById(
			[
				...state.frontier,
				{
					candidateId: event.candidateId,
					candidateDigest: event.candidateDigest,
					disposition: event.disposition,
					frontierDigest: event.frontierDigest,
				},
			],
			"candidateId",
		),
	};
}

function validateTerminalEvidenceBindings(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionTerminalDecisionRecordedEvent,
): void {
	for (let index = 0; index < event.terminalEvidence.measurements.length; index += 1) {
		const evidence = event.terminalEvidence.measurements[index]!;
		const measurement = evidence.measurement;
		const goal = goalFor(state, measurement.goalId);
		const parsed = parseAutoResearchPortfolioMeasurement(clone(measurement), {
			confidenceLevel: goal.uncertainty.confidence,
			evaluationEpoch: state.contract.inputManifest.evaluationEpoch,
			inputManifestDigest: state.contract.inputManifest.manifestDigest,
			splitClosureRoots: state.contract.inputManifest.splitClosureRoots,
		});
		if (parsed.candidateId === null) throw new Error("terminal measurement is not candidate-bound");
		const candidate = candidateFor(state, parsed.candidateId);
		if (event.candidateId !== null && event.candidateId !== parsed.candidateId)
			throw new Error("terminal measurement candidate binding changed");
		if (parsed.kind === "holdout") {
			if (
				!state.holdoutAggregates.some(
					(entry) =>
						entry.candidateId === parsed.candidateId && entry.candidateDigest === candidate.candidateDigest,
				)
			)
				throw new Error("terminal holdout evidence lacks a bound opaque aggregate");
			continue;
		}
		const stored = state.measurements.find((entry) => entry.measurementId === parsed.measurementId);
		if (stored === undefined || stored.measurementDigest !== parsed.measurementDigest)
			throw new Error("terminal measurement is not recorded by the projection");
		if (!candidate.measurementIds.includes(parsed.measurementId))
			throw new Error("terminal measurement candidate index is not bound");
	}
	for (let index = 0; index < event.terminalEvidence.frontier.entries.length; index += 1) {
		const entry = event.terminalEvidence.frontier.entries[index]!;
		const candidate = candidateFor(state, entry.candidateId);
		if (event.candidateId !== null && event.candidateId !== candidate.candidateId)
			throw new Error("terminal frontier candidate binding changed");
		if (!state.frontier.some((record) => record.candidateId === candidate.candidateId))
			throw new Error("terminal frontier evidence is not recorded by the projection");
	}
}

async function applyTerminal(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionTerminalDecisionRecordedEvent,
	context: WorkflowHostReceiptConsumerContext,
): Promise<Partial<AutoResearchPortfolioProjectionState>> {
	validateTerminalEvidenceBindings(state, event);
	if (event.candidateId !== null) {
		const candidate = candidateFor(state, event.candidateId);
		if (candidate.candidateDigest !== event.candidateDigest) throw new Error("terminal candidate binding changed");
		if (!lifecycleAtLeast(candidate, "frontier_exploratory") || candidate.measurementIds.length === 0)
			throw new Error("terminal decision lacks frontier and measurement evidence");
		if (lifecycleAtLeast(candidate, "learning_decided")) throw new Error("terminal lifecycle is not monotonic");
	}
	const terminalInput: PortfolioTerminalInput = {
		contract: state.contract,
		workflowId: state.workflowId,
		currentStateDigest: state.projectionDigest,
		currentRevision: Math.max(1, state.revision),
		trustedNow: event.occurredAt,
		receiptContext: context,
		...event.terminalEvidence,
	};
	const evaluated = await evaluatePortfolioTerminal(terminalInput);
	if (digestObject(evaluated) !== digestObject(event.terminalEvaluation))
		throw new Error("terminal evaluation does not match parsed contract evaluation");
	const existing = state.terminalDecisions.find((entry) => entry.decisionId === event.decisionId);
	const decision: AutoResearchPortfolioProjectionTerminalDecision = {
		decisionId: event.decisionId,
		candidateId: event.candidateId,
		candidateDigest: event.candidateDigest,
		terminalEvaluation: event.terminalEvaluation,
		terminalEvidenceDigest: event.evidenceDigest,
		evidenceDigest: event.evidenceDigest,
	};
	if (existing !== undefined) {
		if (digestObject(existing) !== digestObject(decision)) throw new Error("terminal decision conflicts");
		return {};
	}
	const candidates =
		event.candidateId === null
			? state.candidates
			: replaceCandidate(state, {
					...candidateFor(state, event.candidateId),
					lifecycle: "terminal_decided",
					terminalDecisionId: event.decisionId,
				});
	return { candidates, terminalDecisions: sortedById([...state.terminalDecisions, decision], "decisionId") };
}

function applyLearning(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionLearningDecisionRecordedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	let candidates = state.candidates;
	if (event.candidateId !== null) {
		const candidate = candidateFor(state, event.candidateId);
		if (candidate.candidateDigest !== event.candidateDigest || !lifecycleAtLeast(candidate, "terminal_decided"))
			throw new Error("learning decision candidate binding changed");
		if (candidate.learningDecisionId !== null && candidate.learningDecisionId !== event.decisionId)
			throw new Error("learning decision conflicts");
		candidates = replaceCandidate(state, {
			...candidate,
			lifecycle: "learning_decided",
			learningDecisionId: event.decisionId,
		});
	} else if (event.candidateDigest !== null) throw new Error("null learning decision cannot carry a candidate digest");
	const existing = state.learningDecisions.find((entry) => entry.decisionId === event.decisionId);
	const decision: AutoResearchPortfolioProjectionLearningDecision = {
		decisionId: event.decisionId,
		candidateId: event.candidateId,
		candidateDigest: event.candidateDigest,
		scope: event.scope,
		disposition: event.disposition,
		evidenceDigest: event.evidenceDigest,
	};
	if (existing !== undefined) {
		if (digestObject(existing) !== digestObject(decision)) throw new Error("learning decision conflicts");
		return {};
	}
	return { candidates, learningDecisions: sortedById([...state.learningDecisions, decision], "decisionId") };
}

function applyBudget(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionBudgetUsageRecordedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	const usage = {
		...state.budgetUsage,
		wallMilliseconds: addUsage(
			state.budgetUsage.wallMilliseconds,
			event.usage.wallMilliseconds ?? 0,
			"wallMilliseconds",
		),
		costMicrounits: addUsage(state.budgetUsage.costMicrounits, event.usage.costMicrounits ?? 0, "costMicrounits"),
		tokens: addUsage(state.budgetUsage.tokens, event.usage.tokens ?? 0, "tokens"),
	};
	assertWithinBudget(state.budgetLimits, resolvedUsage(state, usage));
	return { budgetUsage: usage };
}

function budgetReached(state: AutoResearchPortfolioProjectionState): boolean {
	const usage = state.budgetUsage;
	return (
		(state.budgetLimits.maxCandidates !== null &&
			usage.candidates > 0 &&
			usage.candidates >= state.budgetLimits.maxCandidates) ||
		(state.budgetLimits.maxMeasurements !== null &&
			usage.measurements > 0 &&
			usage.measurements >= state.budgetLimits.maxMeasurements) ||
		(state.budgetLimits.maxWallMilliseconds !== null &&
			usage.wallMilliseconds > 0 &&
			usage.wallMilliseconds >= state.budgetLimits.maxWallMilliseconds) ||
		(state.budgetLimits.maxCostMicrounits !== null &&
			usage.costMicrounits > 0 &&
			usage.costMicrounits >= state.budgetLimits.maxCostMicrounits) ||
		(state.budgetLimits.maxTokens !== null && usage.tokens > 0 && usage.tokens >= state.budgetLimits.maxTokens)
	);
}

function applyStatus(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionStatusChangedEvent,
): Partial<AutoResearchPortfolioProjectionState> {
	if (
		STATUS_RANK[event.status] < STATUS_RANK[state.status] ||
		(STATUS_RANK[event.status] === STATUS_RANK[state.status] && event.status !== state.status)
	)
		throw new Error("projection status lifecycle is not monotonic");
	if (event.status === "budget_limited" && !budgetReached(state))
		throw new Error("budget_limited requires authenticated usage reaching a configured budget");
	if (
		event.status === "complete" &&
		!state.terminalDecisions.some(
			(entry) =>
				entry.terminalEvaluation.accepted &&
				(entry.terminalEvaluation.outcome === "complete" ||
					entry.terminalEvaluation.outcome === "complete_with_tradeoff"),
		)
	)
		throw new Error("complete status requires accepted terminal evidence");
	if (
		event.status !== "budget_limited" &&
		(TERMINAL_STATUSES as readonly AutoResearchPortfolioProjectionStatus[]).includes(event.status) &&
		state.terminalDecisions.length === 0
	)
		throw new Error("terminal status requires terminal evidence");
	return { status: event.status, statusReason: event.reason };
}

function stateWith(
	state: AutoResearchPortfolioProjectionState,
	patch: Partial<AutoResearchPortfolioProjectionState>,
	event: AutoResearchPortfolioProjectionEvent,
	authority: WorkflowHostPrincipalCapabilityAuthorization,
): AutoResearchPortfolioProjectionState {
	const scalar = patch.budgetUsage ?? state.budgetUsage;
	const receipts = sortedById(
		[...state.appliedEvents, { eventId: event.eventId, eventDigest: event.eventDigest }],
		"eventId",
	);
	const { projectionDigest: _projectionDigest, ...stateBody } = state;
	const nextWithoutDigest = {
		...stateBody,
		...patch,
		authority,
		revision: event.revision,
		epoch: event.epoch,
		head: event.eventDigest,
		budgetUsage: resolvedUsage({ ...state, ...patch } as AutoResearchPortfolioProjectionState, scalar),
		appliedEvents: receipts,
		appliedEventIds: receipts.map((entry) => entry.eventId),
		appliedEventDigests: receipts.map((entry) => entry.eventDigest),
	};
	return deepFreeze({ ...nextWithoutDigest, projectionDigest: digestProjectionState(nextWithoutDigest) });
}

function validateAuthority(value: unknown, label: string): WorkflowHostPrincipalCapabilityAuthorization {
	assertSafeTree(value, label);
	assertRecord(value, label);
	assertExactKeys(
		value,
		[
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
			"authorizationDigest",
		]
			.filter((key) => value[key] !== undefined)
			.concat(value.executionIdentity === undefined ? [] : ["executionIdentity"])
			.concat(value.sessionId === undefined ? [] : ["sessionId"]),
		label,
	);
	if (
		typeof value.authenticatedPrincipal !== "string" ||
		typeof value.keyOwnerPrincipal !== "string" ||
		value.capability !== CAPABILITY ||
		typeof value.workflowId !== "string" ||
		value.authenticatedPrincipal.trim().length === 0 ||
		value.keyOwnerPrincipal.trim().length === 0
	)
		throw new Error(`${label} is invalid`);
	assertIdentifier(value.workflowId, `${label}.workflowId`);
	assertDigest(value.bindingDigest, `${label}.bindingDigest`);
	assertDigest(value.stateDigest, `${label}.stateDigest`);
	assertPositiveInteger(value.revision, `${label}.revision`);
	assertDigest(value.authorizationDigest, `${label}.authorizationDigest`);
	validateEpochRef(value.epochRef);
	validateReceipt(value.receipt, `${label}.receipt`);
	assertRecord(value.validity, `${label}.validity`);
	assertExactKeys(value.validity, ["issuedAt", "validUntil"], `${label}.validity`);
	assertTimestamp(value.validity.issuedAt, `${label}.validity.issuedAt`);
	assertTimestamp(value.validity.validUntil, `${label}.validity.validUntil`);
	return deepFreeze(clone(value)) as unknown as WorkflowHostPrincipalCapabilityAuthorization;
}

async function authorizeEvent(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionEvent,
	context: WorkflowHostReceiptConsumerContext,
): Promise<WorkflowHostPrincipalCapabilityAuthorization> {
	validateContext(context);
	const receipt = event.hostReceipt;
	if (
		receipt.workflowId !== state.workflowId ||
		receipt.bindingDigest !==
			autoResearchPortfolioProjectionEventBindingDigest(
				event as unknown as Record<string, unknown>,
				state.workflowId,
			)
	)
		throw new Error("projection event receipt binding changed");
	if (
		receipt.capabilityBinding === undefined ||
		receipt.capabilityBinding.capability !== CAPABILITY ||
		receipt.capabilityBinding.resourceDigest !== event.resourceDigest ||
		receipt.capabilityBinding.operationDigest !== event.operationDigest
	)
		throw new Error("projection event capability binding changed");
	const revision = Math.max(1, state.revision);
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt,
		workflowId: state.workflowId,
		bindingDigest: receipt.bindingDigest,
		resourceDigest: event.resourceDigest,
		operationDigest: event.operationDigest,
		stateDigest: state.projectionDigest,
		revision,
		epochRef: state.epochRef,
		capability: CAPABILITY,
		...(receipt.capabilityBinding.executionIdentity === null
			? {}
			: { executionIdentity: receipt.capabilityBinding.executionIdentity }),
		...(receipt.capabilityBinding.sessionId === null ? {} : { sessionId: receipt.capabilityBinding.sessionId }),
	};
	const decision = validateAuthority(
		await context.principalAuthorizer.authorize(authorizationInput),
		"projection principal authorization",
	);
	if (
		decision.capability !== authorizationInput.capability ||
		decision.workflowId !== authorizationInput.workflowId ||
		decision.bindingDigest !== authorizationInput.bindingDigest ||
		decision.stateDigest !== authorizationInput.stateDigest ||
		decision.revision !== authorizationInput.revision ||
		decision.epochRef.storeEpoch !== authorizationInput.epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== authorizationInput.epochRef.coordinatorEpoch ||
		digestObject(decision.receipt) !== digestObject(receipt) ||
		decision.validity.issuedAt !== receipt.issuedAt ||
		decision.validity.validUntil !== receipt.validUntil ||
		decision.executionIdentity !== authorizationInput.executionIdentity ||
		decision.sessionId !== authorizationInput.sessionId
	)
		throw new Error("projection principal authorization does not match the event");
	return decision;
}

function validateState(state: AutoResearchPortfolioProjectionState): void {
	assertDeepFrozen(state, "projection state");
	assertSafeTree(state, "projection state");
	assertRecord(state, "projection state");
	const expected = [
		"schemaVersion",
		"projectionId",
		"workflowId",
		"epochRef",
		"contractDigest",
		"contract",
		"revision",
		"head",
		"epoch",
		"provenance",
		"authority",
		"status",
		"statusReason",
		"candidates",
		"impactClosures",
		"measurements",
		"frontier",
		"terminalDecisions",
		"learningDecisions",
		"holdoutAggregates",
		"budgetLimits",
		"budgetUsage",
		"appliedEventIds",
		"appliedEventDigests",
		"appliedEvents",
		"projectionDigest",
	];
	assertExactKeys(state, expected, "projection state");
	if (state.schemaVersion !== AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION)
		throw new Error("projection state schema version is unsupported");
	assertIdentifier(state.projectionId, "projection state projectionId");
	assertIdentifier(state.workflowId, "projection state workflowId");
	validateEpochRef(state.epochRef);
	assertDigest(state.contractDigest, "projection state contractDigest");
	assertSafeTree(state.contract, "projection state contract");
	const parsedContract = parseAutoResearchPortfolioContract(clone(state.contract));
	if (autoResearchPortfolioContractDigest(parsedContract) !== state.contractDigest)
		throw new Error("projection state contract digest changed");
	assertPositiveInteger(state.epoch, "projection state epoch");
	if (!Number.isSafeInteger(state.revision) || state.revision < 0)
		throw new Error("projection state revision is invalid");
	if (state.head !== null) assertDigest(state.head, "projection state head");
	validateProvenance(state.provenance, "projection state provenance");
	if (state.authority !== null) validateAuthority(state.authority, "projection state authority");
	if (!STATUSES.includes(state.status)) throw new Error("projection state status is invalid");
	if (state.statusReason !== null && (typeof state.statusReason !== "string" || state.statusReason.length === 0))
		throw new Error("projection state status reason is invalid");
	assertClosedArray(state.candidates, "projection state candidates");
	assertClosedArray(state.impactClosures, "projection state impactClosures");
	assertClosedArray(state.measurements, "projection state measurements");
	assertClosedArray(state.frontier, "projection state frontier");
	assertClosedArray(state.terminalDecisions, "projection state terminalDecisions");
	assertClosedArray(state.learningDecisions, "projection state learningDecisions");
	assertClosedArray(state.holdoutAggregates, "projection state holdoutAggregates");
	assertClosedArray(state.appliedEventIds, "projection state appliedEventIds");
	assertClosedArray(state.appliedEventDigests, "projection state appliedEventDigests");
	assertClosedArray(state.appliedEvents, "projection state appliedEvents");
	if (
		state.appliedEventIds.length !== state.appliedEvents.length ||
		state.appliedEventDigests.length !== state.appliedEvents.length
	)
		throw new Error("projection state event receipts are inconsistent");
	for (let index = 0; index < state.appliedEvents.length; index += 1) {
		const receipt = state.appliedEvents[index]!;
		assertExactKeys(
			receipt as unknown as Record<string, unknown>,
			["eventId", "eventDigest"],
			`projection state appliedEvents[${index}]`,
		);
		assertIdentifier(receipt.eventId, `projection state appliedEvents[${index}].eventId`);
		assertDigest(receipt.eventDigest, `projection state appliedEvents[${index}].eventDigest`);
		if (state.appliedEventIds[index] !== receipt.eventId || state.appliedEventDigests[index] !== receipt.eventDigest)
			throw new Error("projection state event indexes are inconsistent");
	}
	const expectedDigest = autoResearchPortfolioProjectionDigest(state);
	if (state.projectionDigest !== expectedDigest) throw new Error("projection state projectionDigest changed");
}

async function applyEvent(
	state: AutoResearchPortfolioProjectionState,
	event: AutoResearchPortfolioProjectionEvent,
	context: WorkflowHostReceiptConsumerContext,
): Promise<Partial<AutoResearchPortfolioProjectionState>> {
	switch (event.kind) {
		case "candidate_registered":
			return applyCandidateRegistration(state, event);
		case "impact_closure_recorded":
			return applyClosure(state, event);
		case "host_vector_measured":
			return applyMeasurement(state, event);
		case "opaque_holdout_aggregate_recorded":
			return applyHoldout(state, event);
		case "frontier_disposition_recorded":
			return applyFrontier(state, event);
		case "terminal_decision_recorded":
			return applyTerminal(state, event, context);
		case "learning_decision_recorded":
			return applyLearning(state, event);
		case "budget_usage_recorded":
			return applyBudget(state, event);
		case "epoch_advanced":
			if (event.fromEpoch !== state.epoch || event.epoch !== state.epoch + 1 || event.revision !== 1)
				throw new Error("epoch transition is not contiguous");
			return {};
		case "status_changed":
			return applyStatus(state, event);
	}
}

/** Apply one authenticated event with exact idempotency and prior-head sequencing. */
export async function reduceAutoResearchPortfolioProjection(
	state: AutoResearchPortfolioProjectionState,
	rawEvent: AutoResearchPortfolioProjectionEvent,
	receiptContext?: WorkflowHostReceiptConsumerContext,
): Promise<AutoResearchPortfolioProjectionState> {
	validateState(state);
	const event = validateEvent(rawEvent);
	const existingIndex = state.appliedEventIds.indexOf(event.eventId);
	if (existingIndex >= 0) {
		if (state.appliedEventDigests[existingIndex] !== event.eventDigest)
			throw new Error(`projection event ${event.eventId} conflicts by digest`);
		return state;
	}
	if ((TERMINAL_STATUSES as readonly AutoResearchPortfolioProjectionStatus[]).includes(state.status))
		throw new Error("projection is terminal and immutable");
	if (
		event.projectionId !== state.projectionId ||
		event.contractDigest !== state.contractDigest ||
		digestObject(event.provenance) !== digestObject(state.provenance)
	)
		throw new Error("projection event contract or provenance binding changed");
	if (event.priorHead !== state.head) throw new Error("projection event prior head does not match current head");
	if (event.kind === "epoch_advanced") {
		if (event.epoch !== state.epoch + 1 || event.revision !== 1)
			throw new Error("epoch transition is not contiguous");
	} else if (event.epoch !== state.epoch || event.revision !== state.revision + 1)
		throw new Error("projection event causal revision or epoch gap");
	if (receiptContext === undefined)
		throw new Error("CONTRACT_CHANGE: projection reduction requires the generic host principalAuthorizer seam");
	const authority = await authorizeEvent(state, event, receiptContext);
	const patch = await applyEvent(state, event, receiptContext);
	return stateWith(state, patch, event, authority);
}

function compareEvents(
	left: AutoResearchPortfolioProjectionEvent,
	right: AutoResearchPortfolioProjectionEvent,
): number {
	return left.epoch - right.epoch || left.revision - right.revision || compareStrings(left.eventId, right.eventId);
}

/** Replay a committed set in canonical causal order; invalid branches remain errors after sorting. */
export async function replayAutoResearchPortfolioProjection(
	input: AutoResearchPortfolioProjectionInput,
	rawEvents: readonly AutoResearchPortfolioProjectionEvent[],
): Promise<AutoResearchPortfolioProjectionState> {
	assertClosedArray(rawEvents, "projection events");
	const seen = new Map<string, string>();
	const events: AutoResearchPortfolioProjectionEvent[] = [];
	for (let index = 0; index < rawEvents.length; index += 1) {
		const event = validateEvent(rawEvents[index]);
		const prior = seen.get(event.eventId);
		if (prior !== undefined && prior !== event.eventDigest)
			throw new Error(`projection event ${event.eventId} conflicts by digest`);
		if (prior === undefined) {
			seen.set(event.eventId, event.eventDigest);
			events.push(event);
		}
	}
	events.sort(compareEvents);
	const checked = validateInput(input);
	let state = initialState(input);
	for (let index = 0; index < events.length; index += 1)
		state = await reduceAutoResearchPortfolioProjection(state, events[index]!, checked.receiptContext);
	return state;
}

/** Return the canonical digest of a projection state without its self-digest. */
export function autoResearchPortfolioProjectionDigest(state: AutoResearchPortfolioProjectionState): string {
	const { projectionDigest: _projectionDigest, ...body } = state;
	return digestProjectionState(body);
}

/** Validate and return a canonical event envelope. */
export function canonicalizeAutoResearchPortfolioProjectionEvent(
	event: AutoResearchPortfolioProjectionEvent,
): AutoResearchPortfolioProjectionEvent {
	return validateEvent(event);
}
