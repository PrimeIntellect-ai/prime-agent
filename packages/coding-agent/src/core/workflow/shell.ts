import type { GoalState } from "../goals.js";
import type {
	DurableApprovalSecretProof,
	WorkflowApprovalRequest,
	WorkflowDecisionRef,
	WorkflowPhaseId,
	WorkflowSignedApprovalArtifact,
	WorkflowStatus,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowLearningPromotionReceiptCapability } from "./learning-promotion-authority.js";

export interface WorkflowAcceptanceState {
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly goalContract?: WorkflowGoalContract | null;
}

export type WorkflowGoalMetricDirection = "at_least" | "at_most" | "exact";
export type WorkflowGoalMetricMeasurement =
	| "public_integration"
	| "fresh_process"
	| "authenticated_artifact"
	| "resource_ledger";

export interface WorkflowGoalMetric {
	readonly metricId: string;
	readonly requirementId: string;
	readonly direction: WorkflowGoalMetricDirection;
	readonly target: number;
	readonly tolerance: number;
	readonly measurement: WorkflowGoalMetricMeasurement;
	readonly guardIds: readonly string[];
}

export interface WorkflowGoalBudgets {
	readonly tokenLimit: number;
	readonly wallTimeLimitSeconds: number;
	readonly spendLimitMicrounits: number;
}

export interface WorkflowGoalAuthoritySourceRequest {
	readonly kind: "immutable_object";
	readonly uri: string;
	readonly objectGeneration: string;
	readonly objectDigest: string;
	readonly objectSizeBytes: number;
	readonly parsedObjective: string;
	readonly boundaryIds: readonly string[];
	readonly gateIds: readonly string[];
}

export interface WorkflowGoalAuthoritySource extends WorkflowGoalAuthoritySourceRequest {
	readonly parsedProgramDigest: string;
	readonly sourceBindingDigest: string;
}

export interface WorkflowGoalContractRequest {
	readonly authoritativeSource: WorkflowGoalAuthoritySourceRequest;
	readonly successMetrics: readonly WorkflowGoalMetric[];
	readonly nonGoalIds: readonly string[];
	readonly budgets: WorkflowGoalBudgets;
}

export interface WorkflowGoalContractAntiGaming {
	readonly activityDoesNotCount: true;
	readonly testCountsDoNotProveCompletion: true;
	readonly guardFailureBlocksProgress: true;
	readonly metricSelectionFixedAtApproval: true;
	readonly reviewDigest: string;
}

export interface WorkflowGoalContract extends WorkflowGoalContractRequest {
	readonly schemaVersion: 1;
	readonly objective: string;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly authoritativeSource: WorkflowGoalAuthoritySource;
	readonly antiGaming: WorkflowGoalContractAntiGaming;
	readonly contractDigest: string;
}

export interface WorkflowShellBlockedReason {
	readonly kind: "cancellation_reconciliation" | "phase_outcome" | "planner_continuity" | "awaiting_external";
	readonly reason: string;
	readonly blockerId?: string;
	readonly blockerDigest?: string;
	readonly owner?: "workflow_host" | "resource_host" | "capability_host" | "external";
	readonly resumeEventKind?: string;
	readonly resumePredicateDigest?: string;
	readonly nextEligibleAt?: string | null;
}

export interface WorkflowShellStatus extends WorkflowAcceptanceState {
	goalContract: WorkflowGoalContract | null;
	workflowId: string | null;
	status: WorkflowStatus | "idle";
	phase: WorkflowPhaseId | null;
	goal: GoalState;
	approvalRequest: WorkflowApprovalRequest | null;
	stateDigest: string | null;
	decisionRefs: readonly WorkflowDecisionRef[];
	resourceEnvelopeDigest: string | null;
	scorecardDigest: string | null;
	pendingWaitReasons: readonly { code: string; detail?: string }[];
	blocked?: WorkflowShellBlockedReason;
}

export interface WorkflowStartRequest {
	workflowId: string;
	objective?: string;
	requestedProfile?: "inline" | "parallel";
	maxWorkers?: number;
	acceptanceChecks?: readonly string[];
	protectedInvariants?: readonly string[];
	goalContract?: WorkflowGoalContractRequest;
}

export interface WorkflowGoalAccountingInput {
	readonly tokenDelta: number;
	readonly wallTimeDeltaSeconds: number;
	readonly continuationDelta: number;
}

export type WorkflowCommand =
	| { kind: "start"; request: WorkflowStartRequest }
	| { kind: "status" }
	| { kind: "decisions" }
	| { kind: "resources" }
	| {
			kind: "respond";
			approvalRequestId: string;
			optionId: string;
			proof: DurableApprovalSecretProof | WorkflowSignedApprovalArtifact;
	  }
	| { kind: "pause"; reason: string }
	| { kind: "resume"; note?: string }
	| { kind: "cancel"; reason?: string };

export interface WorkflowShell {
	execute(command: WorkflowCommand): Promise<WorkflowShellStatus>;
	status(): WorkflowShellStatus;
	/** Host-only capability for transferring an accepted learning promotion into refinement. */
	readonly learningPromotionReceipts?: WorkflowLearningPromotionReceiptCapability;
	accountAssistantUsage?(input: WorkflowGoalAccountingInput): Promise<GoalState>;
	accountContinuation?(input: WorkflowGoalAccountingInput): Promise<GoalState>;
	dispose?(): Promise<void>;
}

export interface WorkflowShellHandlers {
	execute(command: WorkflowCommand): Promise<WorkflowShellStatus>;
	status(): WorkflowShellStatus;
	readonly learningPromotionReceipts?: WorkflowLearningPromotionReceiptCapability;
	accountAssistantUsage?(input: WorkflowGoalAccountingInput): Promise<GoalState>;
	accountContinuation?(input: WorkflowGoalAccountingInput): Promise<GoalState>;
	dispose?(): Promise<void>;
}

function cloneStatus(status: WorkflowShellStatus): WorkflowShellStatus {
	return {
		...status,
		goal: structuredClone(status.goal),
		approvalRequest: status.approvalRequest === null ? null : structuredClone(status.approvalRequest),
		decisionRefs: status.decisionRefs.map((ref) => structuredClone(ref)),
		acceptanceCheckIds: [...status.acceptanceCheckIds],
		protectedInvariantIds: [...status.protectedInvariantIds],
		goalContract: status.goalContract === null ? null : structuredClone(status.goalContract),
		pendingWaitReasons: status.pendingWaitReasons.map((reason) => ({ ...reason })),
		blocked: status.blocked === undefined ? undefined : { ...status.blocked },
	};
}

const GOAL_CONTRACT_KEYS = Object.freeze([
	"schemaVersion",
	"objective",
	"acceptanceCheckIds",
	"protectedInvariantIds",
	"authoritativeSource",
	"successMetrics",
	"nonGoalIds",
	"budgets",
	"antiGaming",
	"contractDigest",
] as const);
const GOAL_AUTHORITY_SOURCE_REQUEST_KEYS = Object.freeze([
	"kind",
	"uri",
	"objectGeneration",
	"objectDigest",
	"objectSizeBytes",
	"parsedObjective",
	"boundaryIds",
	"gateIds",
] as const);
const GOAL_AUTHORITY_SOURCE_KEYS = Object.freeze([
	...GOAL_AUTHORITY_SOURCE_REQUEST_KEYS,
	"parsedProgramDigest",
	"sourceBindingDigest",
] as const);
const GOAL_METRIC_KEYS = Object.freeze([
	"metricId",
	"requirementId",
	"direction",
	"target",
	"tolerance",
	"measurement",
	"guardIds",
] as const);
const GOAL_BUDGET_KEYS = Object.freeze(["tokenLimit", "wallTimeLimitSeconds", "spendLimitMicrounits"] as const);
const GOAL_ANTI_GAMING_KEYS = Object.freeze([
	"activityDoesNotCount",
	"testCountsDoNotProveCompletion",
	"guardFailureBlocksProgress",
	"metricSelectionFixedAtApproval",
	"reviewDigest",
] as const);
const METRIC_DIRECTIONS: ReadonlySet<string> = new Set(["at_least", "at_most", "exact"]);
const METRIC_MEASUREMENTS: ReadonlySet<string> = new Set([
	"public_integration",
	"fresh_process",
	"authenticated_artifact",
	"resource_ledger",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertClosedRecord(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unknown fields.`);
}

function normalizeIdentifiers(values: unknown, fallback: readonly string[], label: string): readonly string[] {
	const selected = Array.isArray(values) && values.length > 0 ? values : fallback;
	if (!selected.every((value) => typeof value === "string"))
		throw new Error(`${label} must contain unique non-empty identifiers.`);
	const normalized = selected.map((value) => value.trim());
	if (
		normalized.some((value) => value.length === 0 || value.length > 256) ||
		new Set(normalized).size !== normalized.length
	)
		throw new Error(`${label} must contain unique non-empty identifiers.`);
	return Object.freeze(normalized);
}

function normalizeMetric(
	value: unknown,
	acceptanceCheckIds: ReadonlySet<string>,
	protectedInvariantIds: ReadonlySet<string>,
): WorkflowGoalMetric {
	if (!isRecord(value)) throw new Error("Workflow success metric must be a closed record.");
	assertClosedRecord(value, GOAL_METRIC_KEYS, "Workflow success metric");
	const metricId = typeof value.metricId === "string" ? value.metricId.trim() : "";
	const requirementId = typeof value.requirementId === "string" ? value.requirementId.trim() : "";
	if (metricId.length === 0 || metricId.length > 256 || requirementId.length === 0 || requirementId.length > 256)
		throw new Error("Workflow success metric identity is invalid.");
	if (!acceptanceCheckIds.has(requirementId))
		throw new Error("Workflow success metric must bind an approved acceptance check.");
	if (typeof value.direction !== "string" || !METRIC_DIRECTIONS.has(value.direction))
		throw new Error("Workflow success metric direction is invalid.");
	if (typeof value.measurement !== "string" || !METRIC_MEASUREMENTS.has(value.measurement))
		throw new Error("Workflow success metric measurement must be an observable host evidence kind.");
	if (typeof value.target !== "number" || !Number.isFinite(value.target))
		throw new Error("Workflow success metric target must be finite.");
	if (typeof value.tolerance !== "number" || !Number.isFinite(value.tolerance) || value.tolerance < 0)
		throw new Error("Workflow success metric tolerance must be finite and non-negative.");
	const guardIds = normalizeIdentifiers(value.guardIds, [], "Workflow success metric guards");
	if (guardIds.length === 0 || guardIds.some((guardId) => !protectedInvariantIds.has(guardId)))
		throw new Error("Workflow success metric guard must be an approved invariant.");
	return Object.freeze({
		metricId,
		requirementId,
		direction: value.direction as WorkflowGoalMetricDirection,
		target: value.target,
		tolerance: value.tolerance,
		measurement: value.measurement as WorkflowGoalMetricMeasurement,
		guardIds,
	});
}

function normalizeBudgets(value: unknown): WorkflowGoalBudgets {
	if (!isRecord(value)) throw new Error("Workflow goal budgets must be a closed record.");
	assertClosedRecord(value, GOAL_BUDGET_KEYS, "Workflow goal budgets");
	for (const key of GOAL_BUDGET_KEYS) {
		const limit = value[key];
		if (!Number.isSafeInteger(limit) || (limit as number) < 0)
			throw new Error(`Workflow goal budget ${key} must be a non-negative safe integer.`);
	}
	return Object.freeze({
		tokenLimit: value.tokenLimit as number,
		wallTimeLimitSeconds: value.wallTimeLimitSeconds as number,
		spendLimitMicrounits: value.spendLimitMicrounits as number,
	});
}

function equalIdentifiers(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeGoalAuthoritySource(
	value: unknown,
	objective: string,
	protectedInvariantIds: readonly string[],
	acceptanceCheckIds: readonly string[],
	persisted: boolean,
): WorkflowGoalAuthoritySource {
	if (!isRecord(value)) throw new Error("Workflow goal source must be a closed record.");
	assertClosedRecord(
		value,
		persisted ? GOAL_AUTHORITY_SOURCE_KEYS : GOAL_AUTHORITY_SOURCE_REQUEST_KEYS,
		"Workflow goal source",
	);
	if (value.kind !== "immutable_object") throw new Error("Workflow goal source kind is invalid.");
	const uri = typeof value.uri === "string" ? value.uri.trim() : "";
	if (uri.length === 0 || uri.length > 4_096 || !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/u.test(uri))
		throw new Error("Workflow goal source URI is invalid.");
	const objectGeneration = typeof value.objectGeneration === "string" ? value.objectGeneration.trim() : "";
	if (!/^\d{1,128}$/u.test(objectGeneration)) throw new Error("Workflow goal source object generation is invalid.");
	const objectDigest = typeof value.objectDigest === "string" ? value.objectDigest.trim() : "";
	if (!/^[0-9a-f]{64}$/u.test(objectDigest)) throw new Error("Workflow goal source object digest is invalid.");
	const uriDigest = /(?:^|\/)sha256=([0-9a-f]{64})(?:\/|$)/u.exec(uri)?.[1];
	if (uriDigest !== undefined && uriDigest !== objectDigest)
		throw new Error("Workflow goal source URI digest does not match its object digest.");
	if (!Number.isSafeInteger(value.objectSizeBytes) || (value.objectSizeBytes as number) <= 0)
		throw new Error("Workflow goal source object size must be a positive safe integer.");
	const parsedObjective = typeof value.parsedObjective === "string" ? value.parsedObjective.trim() : "";
	if (parsedObjective !== objective)
		throw new Error("Workflow goal source parsed objective does not match the objective.");
	const boundaryIds = normalizeIdentifiers(value.boundaryIds, [], "Workflow goal source boundaries");
	if (!equalIdentifiers(boundaryIds, protectedInvariantIds))
		throw new Error("Workflow goal source boundaries do not match the protected invariants.");
	const gateIds = normalizeIdentifiers(value.gateIds, [], "Workflow goal source gates");
	if (!equalIdentifiers(gateIds, acceptanceCheckIds))
		throw new Error("Workflow goal source gates do not match the acceptance checks.");
	const parsedProgramDigest = digestObject({ parsedObjective, boundaryIds, gateIds });
	const withoutBindingDigest = {
		kind: "immutable_object" as const,
		uri,
		objectGeneration,
		objectDigest,
		objectSizeBytes: value.objectSizeBytes as number,
		parsedObjective,
		boundaryIds,
		gateIds,
		parsedProgramDigest,
	};
	const sourceBindingDigest = digestObject(withoutBindingDigest);
	if (
		persisted &&
		(value.parsedProgramDigest !== parsedProgramDigest || value.sourceBindingDigest !== sourceBindingDigest)
	)
		throw new Error("Workflow goal source binding digest is invalid.");
	return Object.freeze({ ...withoutBindingDigest, sourceBindingDigest });
}

function antiGamingReview(input: {
	readonly objective: string;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly authoritativeSource: WorkflowGoalAuthoritySource;
	readonly successMetrics: readonly WorkflowGoalMetric[];
	readonly nonGoalIds: readonly string[];
	readonly budgets: WorkflowGoalBudgets;
}): WorkflowGoalContractAntiGaming {
	const review = {
		activityDoesNotCount: true as const,
		testCountsDoNotProveCompletion: true as const,
		guardFailureBlocksProgress: true as const,
		metricSelectionFixedAtApproval: true as const,
	};
	return Object.freeze({ ...review, reviewDigest: digestObject({ ...input, ...review }) });
}

/**
 * Validate and clone an authenticated durable goal contract.
 *
 * Args:
 * value: Untrusted persisted or public-boundary contract value.
 * Return: Canonical immutable goal contract.
 */
export function parseWorkflowGoalContract(value: unknown): WorkflowGoalContract {
	if (!isRecord(value)) throw new Error("Workflow goal contract must be a closed record.");
	assertClosedRecord(value, GOAL_CONTRACT_KEYS, "Workflow goal contract");
	if (value.schemaVersion !== 1 || typeof value.objective !== "string" || value.objective.trim().length === 0)
		throw new Error("Workflow goal contract identity is invalid.");
	const objective = value.objective.trim();
	const acceptanceCheckIds = normalizeIdentifiers(value.acceptanceCheckIds, [], "Acceptance checks");
	const protectedInvariantIds = normalizeIdentifiers(value.protectedInvariantIds, [], "Protected invariants");
	const authoritativeSource = normalizeGoalAuthoritySource(
		value.authoritativeSource,
		objective,
		protectedInvariantIds,
		acceptanceCheckIds,
		true,
	);
	if (!Array.isArray(value.successMetrics) || value.successMetrics.length === 0 || value.successMetrics.length > 128)
		throw new Error("Workflow goal contract requires bounded causal success metrics.");
	const successMetrics = value.successMetrics.map((metric) =>
		normalizeMetric(metric, new Set(acceptanceCheckIds), new Set(protectedInvariantIds)),
	);
	if (new Set(successMetrics.map((metric) => metric.metricId)).size !== successMetrics.length)
		throw new Error("Workflow goal contract metric IDs must be unique.");
	const nonGoalIds = normalizeIdentifiers(value.nonGoalIds, [], "Workflow non-goals");
	const budgets = normalizeBudgets(value.budgets);
	const expectedAntiGaming = antiGamingReview({
		objective,
		acceptanceCheckIds,
		protectedInvariantIds,
		authoritativeSource,
		successMetrics,
		nonGoalIds,
		budgets,
	});
	if (!isRecord(value.antiGaming)) throw new Error("Workflow goal contract anti-gaming review is missing.");
	assertClosedRecord(value.antiGaming, GOAL_ANTI_GAMING_KEYS, "Workflow goal contract anti-gaming review");
	if (digestObject(value.antiGaming) !== digestObject(expectedAntiGaming))
		throw new Error("Workflow goal contract anti-gaming review is invalid.");
	const withoutDigest = {
		schemaVersion: 1 as const,
		objective,
		acceptanceCheckIds,
		protectedInvariantIds,
		authoritativeSource,
		successMetrics,
		nonGoalIds,
		budgets,
		antiGaming: expectedAntiGaming,
	};
	if (value.contractDigest !== digestObject(withoutDigest))
		throw new Error("Workflow goal contract digest is invalid.");
	return Object.freeze({ ...withoutDigest, contractDigest: value.contractDigest });
}

/**
 * Normalize the complete acceptance and anti-gaming contract before any journal mutation.
 *
 * Args:
 * request: Public workflow start request.
 * Return: Canonical acceptance state persisted by the host projection.
 */
export function normalizeWorkflowAcceptanceRequest(request: WorkflowStartRequest): WorkflowAcceptanceState {
	const acceptanceCheckIds = normalizeIdentifiers(request.acceptanceChecks, ["objective"], "Acceptance checks");
	const protectedInvariantIds = normalizeIdentifiers(
		request.protectedInvariants,
		["workflow-state"],
		"Protected invariants",
	);
	if (request.goalContract === undefined)
		return Object.freeze({ acceptanceCheckIds, protectedInvariantIds, goalContract: null });
	if (typeof request.objective !== "string" || request.objective.trim().length === 0)
		throw new Error("Workflow goal contract requires an explicit objective.");
	if (!isRecord(request.goalContract)) throw new Error("Workflow goal contract request must be a closed record.");
	assertClosedRecord(
		request.goalContract,
		["authoritativeSource", "successMetrics", "nonGoalIds", "budgets"],
		"Workflow goal contract request",
	);
	if (!Array.isArray(request.goalContract.successMetrics))
		throw new Error("Workflow goal contract requires causal success metrics.");
	const successMetrics = request.goalContract.successMetrics.map((metric) =>
		normalizeMetric(metric, new Set(acceptanceCheckIds), new Set(protectedInvariantIds)),
	);
	if (successMetrics.length === 0 || successMetrics.length > 128)
		throw new Error("Workflow goal contract requires bounded causal success metrics.");
	if (new Set(successMetrics.map((metric) => metric.metricId)).size !== successMetrics.length)
		throw new Error("Workflow goal contract metric IDs must be unique.");
	const nonGoalIds = normalizeIdentifiers(request.goalContract.nonGoalIds, [], "Workflow non-goals");
	const budgets = normalizeBudgets(request.goalContract.budgets);
	const objective = request.objective.trim();
	const authoritativeSource = normalizeGoalAuthoritySource(
		request.goalContract.authoritativeSource,
		objective,
		protectedInvariantIds,
		acceptanceCheckIds,
		false,
	);
	const antiGaming = antiGamingReview({
		objective,
		acceptanceCheckIds,
		protectedInvariantIds,
		authoritativeSource,
		successMetrics,
		nonGoalIds,
		budgets,
	});
	const withoutDigest = {
		schemaVersion: 1 as const,
		objective,
		acceptanceCheckIds,
		protectedInvariantIds,
		authoritativeSource,
		successMetrics,
		nonGoalIds,
		budgets,
		antiGaming,
	};
	const goalContract = Object.freeze({ ...withoutDigest, contractDigest: digestObject(withoutDigest) });
	return Object.freeze({ acceptanceCheckIds, protectedInvariantIds, goalContract });
}

function freezeCommandValue(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	if (Array.isArray(value)) {
		for (const item of value) freezeCommandValue(item);
	} else {
		for (const item of Object.values(value)) freezeCommandValue(item);
	}
	Object.freeze(value);
}

export function snapshotWorkflowCommand(command: WorkflowCommand): WorkflowCommand {
	const snapshot = structuredClone(command);
	freezeCommandValue(snapshot);
	return snapshot;
}

/**
 * Wraps host-owned command handlers with a disposable, immutable status view.
 *
 * Args:
 * handlers: Journal-backed handlers supplied by the phase host.
 * Return: A worker-free shell facade.
 */
export function createWorkflowShell(handlers: WorkflowShellHandlers): WorkflowShell {
	let disposed = false;
	const assertLive = (): void => {
		if (disposed) throw new Error("Workflow shell has been disposed.");
	};
	const learningPromotionReceipts =
		handlers.learningPromotionReceipts === undefined
			? undefined
			: Object.freeze({
					issue: async (input: Parameters<WorkflowLearningPromotionReceiptCapability["issue"]>[0]) => {
						assertLive();
						return structuredClone(await handlers.learningPromotionReceipts!.issue(structuredClone(input)));
					},
					consume: async (input: Parameters<WorkflowLearningPromotionReceiptCapability["consume"]>[0]) => {
						assertLive();
						return structuredClone(await handlers.learningPromotionReceipts!.consume(structuredClone(input)));
					},
					consumeAndApply: async (
						input: Parameters<WorkflowLearningPromotionReceiptCapability["consumeAndApply"]>[0],
					) => {
						assertLive();
						return structuredClone(
							await handlers.learningPromotionReceipts!.consumeAndApply(structuredClone(input)),
						);
					},
					rollback: async (input: Parameters<WorkflowLearningPromotionReceiptCapability["rollback"]>[0]) => {
						assertLive();
						return structuredClone(await handlers.learningPromotionReceipts!.rollback(structuredClone(input)));
					},
				});
	return {
		async execute(command): Promise<WorkflowShellStatus> {
			assertLive();
			return cloneStatus(await handlers.execute(snapshotWorkflowCommand(command)));
		},
		status(): WorkflowShellStatus {
			assertLive();
			return cloneStatus(handlers.status());
		},
		learningPromotionReceipts,
		accountAssistantUsage:
			handlers.accountAssistantUsage === undefined
				? undefined
				: async (input): Promise<GoalState> => {
						assertLive();
						const accountAssistantUsage = handlers.accountAssistantUsage;
						if (accountAssistantUsage === undefined)
							throw new Error("Workflow goal usage coordinator is unavailable.");
						return structuredClone(await accountAssistantUsage(structuredClone(input)));
					},
		accountContinuation:
			handlers.accountContinuation === undefined
				? undefined
				: async (input): Promise<GoalState> => {
						assertLive();
						const accountContinuation = handlers.accountContinuation;
						if (accountContinuation === undefined)
							throw new Error("Workflow goal continuation coordinator is unavailable.");
						return structuredClone(await accountContinuation(structuredClone(input)));
					},
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			await handlers.dispose?.();
		},
	};
}
