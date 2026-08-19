import type {
	WorkflowActiveLeaseContext,
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEfficiencyRedTeamInvocation,
	WorkflowEfficiencyRedTeamResult,
	WorkflowEfficiencyRedTeamSnapshot,
	WorkflowEfficiencyRedTeamSuccessResult,
	WorkflowEfficiencyRedTeamSuggestion,
	WorkflowEfficiencyReviewSchedule,
	WorkflowEpochRef,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowResourceVector,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import type { WorkflowRevisionBoundaryReader } from "./dispatch.js";
import { assertRevisionBoundary } from "./dispatch.js";
import type { PersistedSessionWorkflowHost } from "./session-host-factory.js";

export type WorkflowEfficiencyRedTeamSchedule = WorkflowEfficiencyReviewSchedule;

export interface WorkflowReadOnlyEfficiencyRedTeamToken {
	readonly tokenId: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly revisionTupleDigest: string;
	readonly snapshotDigest: string;
	readonly expiresAtMonotonicMs: number;
	readonly remainingTokens: number;
	readonly remainingWallMilliseconds: number;
}

export interface WorkflowEfficiencyRedTeamReadPort {
	readSnapshot(token: WorkflowReadOnlyEfficiencyRedTeamToken): Promise<WorkflowEfficiencyRedTeamSnapshot>;
	readJournalSlice(
		token: WorkflowReadOnlyEfficiencyRedTeamToken,
		fromSequence: number,
		limit: number,
	): Promise<readonly unknown[]>;
	readEvidenceRefs(token: WorkflowReadOnlyEfficiencyRedTeamToken): Promise<readonly WorkflowArtifactRef[]>;
	readCapacityObservation(token: WorkflowReadOnlyEfficiencyRedTeamToken): Promise<unknown>;
}

export interface WorkflowEfficiencyRedTeamReviewer {
	review(
		invocation: WorkflowEfficiencyRedTeamInvocation,
		token: WorkflowReadOnlyEfficiencyRedTeamToken,
	): Promise<WorkflowEfficiencyRedTeamResult>;
}

export interface WorkflowEfficiencyRedTeamReviewerDependencies {
	readonly readPort: WorkflowEfficiencyRedTeamReadPort;
	readonly trustedNow: () => string;
	readonly artifactResolver?: WorkflowArtifactResolver;
}

export interface WorkflowEfficiencyReallocationProposal {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly dueWindowId: string;
	readonly sourceHead: WorkflowJournalHead;
	readonly result: WorkflowEfficiencyRedTeamSuccessResult;
	readonly suggestion: WorkflowEfficiencyRedTeamSuggestion;
	readonly invocationTokenDigest: string;
	readonly reportDigest: string;
}

export interface WorkflowEfficiencyReallocationConsumerResult {
	readonly disposition: "accepted" | "already_consumed" | "rejected";
	readonly operationId: string;
}

export interface WorkflowEfficiencyReallocationConsumer {
	consume(proposal: WorkflowEfficiencyReallocationProposal): Promise<WorkflowEfficiencyReallocationConsumerResult>;
}

const efficiencyRedTeamHostAuthorities = new WeakMap<
	PersistedSessionWorkflowHost,
	WorkflowEfficiencyRedTeamHostAuthority
>();
const issuedEfficiencyRedTeamHostAuthorities = new WeakSet<WorkflowEfficiencyRedTeamHostAuthority>();

/** Opaque authority issued for one authenticated persisted workflow host. */
export class WorkflowEfficiencyRedTeamHostAuthority {
	private constructor(
		private readonly boundRuntimeStore: WorkflowRuntimeStore,
		private readonly boundDurableContext: WorkflowRuntimeStoreDurableContext,
		private readonly boundWorkflowId: string,
	) {}

	public static fromHost(host: PersistedSessionWorkflowHost): WorkflowEfficiencyRedTeamHostAuthority {
		assertEfficiencySessionHost(host);
		const runtimeStore = host.runtimeStore;
		const durableContext = runtimeStore.durableContext;
		if (durableContext === undefined)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_host_authority_required");
		return new WorkflowEfficiencyRedTeamHostAuthority(runtimeStore, durableContext, runtimeStore.identity.workflowId);
	}

	public get runtimeStore(): WorkflowRuntimeStore {
		return this.boundRuntimeStore;
	}

	public get durableContext(): WorkflowRuntimeStoreDurableContext {
		return this.boundDurableContext;
	}

	public get workflowId(): string {
		return this.boundWorkflowId;
	}
}

function assertEfficiencySessionHost(host: PersistedSessionWorkflowHost): void {
	if (
		typeof host !== "object" ||
		host === null ||
		typeof host.runtimeStore !== "object" ||
		host.runtimeStore === null ||
		host.runtimeStore.identity.storeKind !== "workflow" ||
		host.runtimeStore.durableContext === undefined ||
		typeof host.execute !== "function" ||
		typeof host.status !== "function" ||
		typeof host.runOutcome !== "function" ||
		typeof host.ensurePrimeWorkflow !== "function" ||
		typeof host.recoveryReadiness !== "function" ||
		typeof host.recoverBeforeResume !== "function"
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_host_authority_required");
}

/**
 * Issue an opaque authority for the exact persisted workflow host and store.
 *
 * Args:
 * host: Authenticated persisted session host returned by the host factory.
 * Return: Opaque authority accepted by the efficiency runtime factory.
 */
export function issueWorkflowEfficiencyRedTeamHostAuthority(
	host: PersistedSessionWorkflowHost,
): WorkflowEfficiencyRedTeamHostAuthority {
	assertEfficiencySessionHost(host);
	const existing = efficiencyRedTeamHostAuthorities.get(host);
	if (existing !== undefined) return existing;
	const authority = WorkflowEfficiencyRedTeamHostAuthority.fromHost(host);
	efficiencyRedTeamHostAuthorities.set(host, authority);
	issuedEfficiencyRedTeamHostAuthorities.add(authority);
	return authority;
}

export interface WorkflowEfficiencyReviewStore {
	replay(input: { workflowId: string; fromSequence: number; expectedStoreEpoch: number }): Promise<{
		events: readonly unknown[];
		head: unknown;
	}>;
}

export interface WorkflowEfficiencyDurableWindowTransaction {
	claimWindow(input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		dueWindowId: string;
		scheduleDigest: string;
		catchUp: boolean;
	}): Promise<"claimed" | "already_claimed" | "conflict">;
	consumeToken(input: {
		workflowId: string;
		epochRef: WorkflowEpochRef;
		tokenId: string;
		dueWindowId: string;
		scheduleDigest: string;
	}): Promise<"consumed" | "already_consumed" | "conflict">;
}

export interface WorkflowEfficiencyReviewInvocationFactoryInput {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	dueWindowId: string;
	schedule: WorkflowEfficiencyReviewSchedule;
	token: WorkflowReadOnlyEfficiencyRedTeamToken;
}

export interface WorkflowEfficiencyRedTeamWakeInput {
	readonly invocation: WorkflowEfficiencyRedTeamInvocation;
	readonly token: WorkflowReadOnlyEfficiencyRedTeamToken;
	readonly schedule: WorkflowEfficiencyReviewSchedule;
}

export interface WorkflowEfficiencyBoundaryAppendInput {
	eventKind: string;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	dueWindowId: string;
	result?: WorkflowEfficiencyRedTeamResult;
	hostMeasuredUsage?: WorkflowResourceVector;
	schedule?: WorkflowEfficiencyReviewSchedule;
	idempotencyKey?: string;
	expectedHead?: unknown;
	expectedHeadDigest?: string;
}

export interface WorkflowEfficiencyBoundaryAppendResult {
	payload?: unknown;
	committed?: unknown;
}

export interface WorkflowEfficiencyRedTeamRuntimeDependencies {
	readonly approvedSchedule: WorkflowEfficiencyReviewSchedule;
	readonly reviewer: WorkflowEfficiencyRedTeamReviewer;
	readonly trustedNow: () => string;
	readonly trustedMonotonicNow?: () => number;
	readonly readActiveLeaseContext?: () => Promise<WorkflowActiveLeaseContext>;
	readonly readCurrentJournalHead?: () => Promise<WorkflowJournalHead>;
	readonly reallocationConsumer?: WorkflowEfficiencyReallocationConsumer;
	readonly reviewStore?: WorkflowEfficiencyReviewStore;
	readonly durableWindowTransaction?: WorkflowEfficiencyDurableWindowTransaction;
	readonly rootHostAppendBoundary?: (
		input: WorkflowEfficiencyBoundaryAppendInput,
	) => Promise<WorkflowEfficiencyBoundaryAppendResult>;
	readonly snapshotResolver: (
		invocation: WorkflowEfficiencyRedTeamInvocation,
	) => Promise<WorkflowEfficiencyRedTeamSnapshot>;
	readonly scheduleManifestRef: WorkflowArtifactRef;
	readonly scheduleArtifactResolver: WorkflowArtifactResolver;
	readonly snapshotArtifactResolver?: WorkflowArtifactResolver;
	readonly reviewInvocationFactory:
		| ((input: WorkflowEfficiencyReviewInvocationFactoryInput) => Promise<WorkflowEfficiencyRedTeamInvocation>)
		| ((token: WorkflowReadOnlyEfficiencyRedTeamToken) => Promise<WorkflowEfficiencyRedTeamInvocation>);
	readonly readOnlyCapabilityProofResolver?:
		| (() => Promise<WorkflowArtifactRef>)
		| ((invocation: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowArtifactRef>);
	readonly readUsage?:
		| (() => Promise<WorkflowResourceVector>)
		| ((invocation: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowResourceVector>);
	readonly overheadReserve?: WorkflowResourceVector;
	readonly readRevisionBoundaryContext?: WorkflowRevisionBoundaryReader["readRevisionBoundaryContext"];
	readonly revisionRegistry?: WorkflowRevisionBoundaryReader["revisionRegistry"];
}

export interface WorkflowEfficiencyRedTeamRuntimeFactoryInput {
	readonly hostAuthority: WorkflowEfficiencyRedTeamHostAuthority;
	readonly approvedSchedule: WorkflowEfficiencyReviewSchedule;
	readonly readPort: WorkflowEfficiencyRedTeamReadPort;
	readonly reviewer: WorkflowEfficiencyRedTeamReviewer;
	readonly trustedNow: () => string;
	readonly trustedMonotonicNow: () => number;
	readonly readActiveLeaseContext: () => Promise<WorkflowActiveLeaseContext>;
	readonly rootHostAppendBoundary: (
		input: WorkflowEfficiencyBoundaryAppendInput,
	) => Promise<WorkflowEfficiencyBoundaryAppendResult>;
	readonly snapshotResolver: (
		invocation: WorkflowEfficiencyRedTeamInvocation,
	) => Promise<WorkflowEfficiencyRedTeamSnapshot>;
	readonly scheduleManifestRef: WorkflowArtifactRef;
	readonly scheduleArtifactResolver: WorkflowArtifactResolver;
	readonly snapshotArtifactResolver: WorkflowArtifactResolver;
	readonly reviewInvocationFactory:
		| ((input: WorkflowEfficiencyReviewInvocationFactoryInput) => Promise<WorkflowEfficiencyRedTeamInvocation>)
		| ((token: WorkflowReadOnlyEfficiencyRedTeamToken) => Promise<WorkflowEfficiencyRedTeamInvocation>);
	readonly readOnlyCapabilityProofResolver:
		| (() => Promise<WorkflowArtifactRef>)
		| ((invocation: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowArtifactRef>);
	readonly readUsage:
		| (() => Promise<WorkflowResourceVector>)
		| ((invocation: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowResourceVector>);
	readonly overheadReserve?: WorkflowResourceVector;
	readonly readRevisionBoundaryContext: WorkflowRevisionBoundaryReader["readRevisionBoundaryContext"];
	readonly revisionRegistry: WorkflowRevisionBoundaryReader["revisionRegistry"];
	readonly reallocationConsumer: WorkflowEfficiencyReallocationConsumer;
}

export interface WorkflowEfficiencyCommittedEvent {
	readonly kind: string;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly eventSequence: number;
	readonly eventDigest: string;
	readonly committed?: boolean;
}

export interface WorkflowEfficiencyRedTeamRuntime {
	wake(
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
	): Promise<WorkflowEfficiencyRedTeamResult | null>;
	wakeInvocation(input: WorkflowEfficiencyRedTeamWakeInput): Promise<WorkflowEfficiencyRedTeamResult | null>;
	wakeInvocation(
		invocation: WorkflowEfficiencyRedTeamInvocation,
		token: WorkflowReadOnlyEfficiencyRedTeamToken,
	): Promise<WorkflowEfficiencyRedTeamResult | null>;
	onCommittedEvent(event: WorkflowEfficiencyCommittedEvent): Promise<WorkflowEfficiencyRedTeamResult | null>;
	recover(
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
	): Promise<WorkflowEfficiencyRedTeamResult | null>;
	crashAfterWakeInFreshProcess(
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
	): Promise<WorkflowEfficiencyRedTeamResult | null>;
}

export class WorkflowEfficiencyReviewerError extends Error {
	readonly code: string;

	public constructor(code: string) {
		super(code);
		this.name = "WorkflowEfficiencyReviewerError";
		this.code = code;
	}
}

const TRIGGER_KINDS: Readonly<Record<string, WorkflowEfficiencyReviewSchedule["triggerSet"][number]>> = {
	task_terminal: "task_terminal",
	milestone_committed: "completion_gate",
	failure: "incident",
	regression: "incident",
	allocation_applied: "result_transition",
	allocation_reconciled: "result_transition",
	adaptive_allocation_applied: "result_transition",
	adaptive_allocation_reallocated: "result_transition",
	adaptive_allocation_reconciled: "result_transition",
	adaptive_allocation_uncertain: "incident",
	adaptive_measured: "material_evidence_transition",
	adaptive_rollback_applied: "incident",
	material_evidence: "material_evidence_transition",
	result_transition: "result_transition",
	phase_transition: "phase_transition",
	lease_release: "lease_release",
	recovery_boundary: "recovery_boundary",
	completion_gate: "completion_gate",
	completed: "completion_gate",
	verified: "completion_gate",
	workflow_child_outcome_committed: "task_terminal",
	workflow_effect_ambiguous: "incident",
	improvement_reviewed: "result_transition",
};
const VALID_TRIGGER_KINDS = new Set(Object.values(TRIGGER_KINDS));

const RESOURCE_FIELDS: readonly (keyof Omit<WorkflowResourceVector, "accelerators" | "providers">)[] = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
];

const CONTROL_CAPACITY_FIELDS: readonly (keyof WorkflowEfficiencyReviewSchedule["dedicatedControlReserve"])[] = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
];

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function isEfficiencyEpochRef(value: unknown): value is WorkflowEpochRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<WorkflowEpochRef>;
	return (
		Number.isSafeInteger(candidate.storeEpoch) &&
		(candidate.storeEpoch ?? 0) > 0 &&
		Number.isSafeInteger(candidate.coordinatorEpoch) &&
		(candidate.coordinatorEpoch ?? 0) > 0
	);
}

function isEfficiencyRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEfficiencyJournalHead(value: unknown): value is WorkflowJournalHead {
	if (!isEfficiencyRecord(value)) return false;
	return (
		typeof value.workflowId === "string" &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence >= 0 &&
		(value.eventDigest === null || typeof value.eventDigest === "string") &&
		isEfficiencyEpochRef(value.epochRef)
	);
}

function isFinitePositive(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function validControlCapacity(value: unknown): value is WorkflowEfficiencyReviewSchedule["dedicatedControlReserve"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<WorkflowEfficiencyReviewSchedule["dedicatedControlReserve"]>;
	return CONTROL_CAPACITY_FIELDS.every((field) => Number.isSafeInteger(candidate[field]) && candidate[field]! >= 0);
}

/**
 * Compute the digest over the schedule fields that remain immutable for a revision.
 *
 * Args:
 * schedule: Candidate or approved schedule to canonicalize.
 * Return: Digest of the immutable schedule preimage.
 */
export function workflowEfficiencyReviewScheduleDigest(schedule: WorkflowEfficiencyReviewSchedule): string {
	return digestObject(scheduleImmutableFields(schedule));
}

function scheduleImmutableFields(schedule: WorkflowEfficiencyReviewSchedule): Record<string, unknown> {
	const {
		scheduleDigest: _scheduleDigest,
		lastRunAt: _lastRunAt,
		lastAdmittedWindowSequence: _lastAdmittedWindowSequence,
		lastAdmittedWindowId: _lastAdmittedWindowId,
		status: _status,
		...immutable
	} = schedule;
	return immutable;
}

function partitionCapacityFits(
	partition: unknown,
	reserve: WorkflowEfficiencyReviewSchedule["dedicatedControlReserve"],
): boolean {
	if (!validControlCapacity(partition)) return false;
	return CONTROL_CAPACITY_FIELDS.every((field) => partition[field] <= reserve[field]);
}

function reservePartitionsFit(schedule: WorkflowEfficiencyReviewSchedule): boolean {
	if (typeof schedule.reservePartitions !== "object" || schedule.reservePartitions === null) return false;
	const partitions = Object.values(schedule.reservePartitions);
	if (!partitions.every((partition) => partitionCapacityFits(partition, schedule.dedicatedControlReserve)))
		return false;
	return CONTROL_CAPACITY_FIELDS.every((field) => {
		const total = partitions.reduce((sum, partition) => sum + partition[field], 0);
		return total <= schedule.dedicatedControlReserve[field];
	});
}

function resourceAdmissionLedgerMatches(schedule: WorkflowEfficiencyReviewSchedule): boolean {
	const admission = schedule.reviewResourceAdmission as {
		canonicalLedgerRef?: unknown;
		canonicalLedgerDigest?: unknown;
	};
	return (
		isCanonicalArtifactRef(admission.canonicalLedgerRef) &&
		digestObject(admission.canonicalLedgerRef) === digestObject(schedule.reserveLedgerRef) &&
		admission.canonicalLedgerDigest === schedule.reserveLedgerDigest
	);
}

function artifactRef(label: string): WorkflowArtifactRef {
	return {
		artifactId: label,
		relativePath: `artifacts/${label}`,
		digest: digestObject({ label }),
		sizeBytes: 0,
		sourceEventSequence: 0,
	};
}

function zeroVector(): WorkflowResourceVector {
	return {
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 0,
		monetaryMicrounits: 0,
	};
}

function readReviewId(invocation: WorkflowEfficiencyRedTeamInvocation): string {
	const candidate = invocation as Partial<WorkflowEfficiencyRedTeamInvocation>;
	return typeof candidate.reviewId === "string" && candidate.reviewId.length > 0 ? candidate.reviewId : "review";
}

function readInvocationUsage(invocation: WorkflowEfficiencyRedTeamInvocation): WorkflowResourceVector {
	const candidate = invocation as Partial<WorkflowEfficiencyRedTeamInvocation>;
	return candidate.actualUsage ?? zeroVector();
}

function invocationRef(invocation: WorkflowEfficiencyRedTeamInvocation): WorkflowArtifactRef {
	const candidate = invocation as Partial<WorkflowEfficiencyRedTeamInvocation> & {
		invocationRef?: WorkflowArtifactRef;
	};
	return candidate.invocationRef ?? artifactRef(`invocation-${readReviewId(invocation)}`);
}

function isValidReadOnlyToken(value: unknown): value is WorkflowReadOnlyEfficiencyRedTeamToken {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkflowReadOnlyEfficiencyRedTeamToken>;
	return (
		typeof candidate.tokenId === "string" &&
		candidate.tokenId.length > 0 &&
		typeof candidate.workflowId === "string" &&
		candidate.workflowId.length > 0 &&
		typeof candidate.epochRef === "object" &&
		candidate.epochRef !== null &&
		Number.isSafeInteger(candidate.epochRef.storeEpoch) &&
		candidate.epochRef.storeEpoch > 0 &&
		Number.isSafeInteger(candidate.epochRef.coordinatorEpoch) &&
		candidate.epochRef.coordinatorEpoch > 0 &&
		typeof candidate.revisionTupleDigest === "string" &&
		candidate.revisionTupleDigest.length > 0 &&
		typeof candidate.snapshotDigest === "string" &&
		typeof candidate.expiresAtMonotonicMs === "number" &&
		Number.isFinite(candidate.expiresAtMonotonicMs) &&
		candidate.expiresAtMonotonicMs > 0 &&
		typeof candidate.remainingTokens === "number" &&
		Number.isFinite(candidate.remainingTokens) &&
		candidate.remainingTokens > 0 &&
		typeof candidate.remainingWallMilliseconds === "number" &&
		Number.isFinite(candidate.remainingWallMilliseconds) &&
		candidate.remainingWallMilliseconds > 0
	);
}

function isCanonicalArtifactRef(value: unknown): value is WorkflowArtifactRef {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkflowArtifactRef>;
	return (
		typeof candidate.artifactId === "string" &&
		candidate.artifactId.length > 0 &&
		!candidate.artifactId.includes("/") &&
		!candidate.artifactId.includes("\\") &&
		!candidate.artifactId.includes("\u0000") &&
		typeof candidate.relativePath === "string" &&
		candidate.relativePath.length > 0 &&
		candidate.relativePath.charCodeAt(0) !== 47 &&
		!candidate.relativePath.includes("\\") &&
		!candidate.relativePath.includes("\u0000") &&
		!candidate.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..") &&
		typeof candidate.digest === "string" &&
		candidate.digest.length > 0 &&
		typeof candidate.sizeBytes === "number" &&
		Number.isSafeInteger(candidate.sizeBytes) &&
		candidate.sizeBytes >= 0 &&
		typeof candidate.sourceEventSequence === "number" &&
		Number.isSafeInteger(candidate.sourceEventSequence) &&
		candidate.sourceEventSequence >= 0
	);
}

function isCommittedDecisionRef(value: unknown, workflowId: string, epochRef: WorkflowEpochRef): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		decisionScope?: { kind?: unknown; workflowId?: unknown; rootSessionId?: unknown };
		decisionId?: unknown;
		revision?: unknown;
		storeEpoch?: unknown;
		coordinatorEpoch?: unknown;
		decisionDigest?: unknown;
	};
	return (
		candidate.decisionScope?.kind === "workflow" &&
		candidate.decisionScope.workflowId === workflowId &&
		typeof candidate.decisionScope.rootSessionId === "string" &&
		candidate.decisionScope.rootSessionId.length > 0 &&
		typeof candidate.decisionId === "string" &&
		candidate.decisionId.length > 0 &&
		Number.isSafeInteger(candidate.revision) &&
		(candidate.revision as number) > 0 &&
		candidate.storeEpoch === epochRef.storeEpoch &&
		candidate.coordinatorEpoch === epochRef.coordinatorEpoch &&
		typeof candidate.decisionDigest === "string" &&
		candidate.decisionDigest.length > 0
	);
}

function isCommittedApprovalReceipt(value: unknown, workflowId: string, revision: number): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		receiptKind?: unknown;
		oneUse?: unknown;
		receiptId?: unknown;
		issuerId?: unknown;
		workflowId?: unknown;
		bindingDigest?: unknown;
		payloadDigest?: unknown;
		artifactRef?: unknown;
		issuedAt?: unknown;
		validUntil?: unknown;
		keyId?: unknown;
		signatureAlgorithm?: unknown;
		artifactBytesDigest?: unknown;
		stateDigest?: unknown;
		revision?: unknown;
		signature?: unknown;
		verificationDigest?: unknown;
	};
	return (
		candidate.receiptKind === "decision" &&
		typeof candidate.oneUse === "boolean" &&
		[
			"receiptId",
			"issuerId",
			"bindingDigest",
			"payloadDigest",
			"keyId",
			"stateDigest",
			"signature",
			"verificationDigest",
		].every(
			(field) =>
				typeof candidate[field as keyof typeof candidate] === "string" &&
				(candidate[field as keyof typeof candidate] as string).length > 0,
		) &&
		candidate.workflowId === workflowId &&
		isCanonicalArtifactRef(candidate.artifactRef) &&
		typeof candidate.issuedAt === "string" &&
		typeof candidate.validUntil === "string" &&
		Number.isFinite(Date.parse(candidate.issuedAt)) &&
		Number.isFinite(Date.parse(candidate.validUntil)) &&
		Date.parse(candidate.validUntil) > Date.parse(candidate.issuedAt) &&
		candidate.keyId !== "" &&
		candidate.signatureAlgorithm === "ed25519" &&
		candidate.artifactBytesDigest === (candidate.artifactRef as WorkflowArtifactRef).digest &&
		candidate.revision === revision
	);
}

function isCommittedResourceAdmission(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		capacityGrant?: {
			kind?: unknown;
			grantId?: unknown;
			grantDigest?: unknown;
			canonicalPoolLedgerRef?: unknown;
			resourceVector?: unknown;
			controlCapacity?: unknown;
		};
		canonicalPoolLedgerRef?: unknown;
		controlCapacity?: unknown;
		controlCapacityProjectionDigest?: unknown;
		declaredVector?: unknown;
		hostDerivedConservativeVector?: unknown;
		reservedVector?: unknown;
		declaredControlCapacity?: unknown;
		hostDerivedControlCapacity?: unknown;
		reservedControlCapacity?: unknown;
		derivationPolicyDigest?: unknown;
		enforcementClass?: unknown;
		unknownPoolIds?: unknown;
		canonicalLedgerRef?: unknown;
		canonicalLedgerDigest?: unknown;
		admitted?: unknown;
		admissionDigest?: unknown;
	};
	return (
		(candidate.capacityGrant?.kind === "worker" || candidate.capacityGrant?.kind === "control") &&
		typeof candidate.capacityGrant.grantId === "string" &&
		candidate.capacityGrant.grantId.length > 0 &&
		typeof candidate.capacityGrant.grantDigest === "string" &&
		candidate.capacityGrant.grantDigest.length > 0 &&
		isCanonicalArtifactRef(candidate.capacityGrant.canonicalPoolLedgerRef) &&
		isCanonicalArtifactRef(candidate.canonicalPoolLedgerRef) &&
		isCanonicalArtifactRef(candidate.canonicalLedgerRef) &&
		digestObject(candidate.capacityGrant.canonicalPoolLedgerRef) === digestObject(candidate.canonicalPoolLedgerRef) &&
		digestObject(candidate.canonicalPoolLedgerRef) === digestObject(candidate.canonicalLedgerRef) &&
		candidate.canonicalLedgerRef.digest === candidate.canonicalLedgerDigest &&
		validControlCapacity(candidate.controlCapacity) &&
		isFiniteResourceVector(candidate.capacityGrant.resourceVector) &&
		validControlCapacity(candidate.capacityGrant.controlCapacity) &&
		validControlCapacity(candidate.declaredControlCapacity) &&
		validControlCapacity(candidate.hostDerivedControlCapacity) &&
		validControlCapacity(candidate.reservedControlCapacity) &&
		isFiniteResourceVector(candidate.declaredVector) &&
		isFiniteResourceVector(candidate.hostDerivedConservativeVector) &&
		isFiniteResourceVector(candidate.reservedVector) &&
		fitsOverheadReserve(candidate.reservedVector, candidate.capacityGrant.resourceVector) &&
		fitsOverheadReserve(candidate.hostDerivedConservativeVector, candidate.capacityGrant.resourceVector) &&
		fitsOverheadReserve(candidate.reservedVector, candidate.declaredVector) &&
		fitsOverheadReserve(candidate.reservedVector, candidate.hostDerivedConservativeVector) &&
		partitionCapacityFits(candidate.reservedControlCapacity, candidate.declaredControlCapacity) &&
		partitionCapacityFits(candidate.reservedControlCapacity, candidate.hostDerivedControlCapacity) &&
		partitionCapacityFits(candidate.reservedControlCapacity, candidate.capacityGrant.controlCapacity) &&
		partitionCapacityFits(candidate.reservedControlCapacity, candidate.controlCapacity) &&
		typeof candidate.controlCapacityProjectionDigest === "string" &&
		candidate.controlCapacityProjectionDigest.length > 0 &&
		typeof candidate.derivationPolicyDigest === "string" &&
		candidate.derivationPolicyDigest.length > 0 &&
		(candidate.enforcementClass === "isolated_metered" ||
			candidate.enforcementClass === "host_bounded" ||
			candidate.enforcementClass === "exclusive_unisolated") &&
		Array.isArray(candidate.unknownPoolIds) &&
		candidate.unknownPoolIds.every((poolId) => typeof poolId === "string") &&
		candidate.unknownPoolIds.length === 0 &&
		candidate.admitted === true &&
		typeof candidate.admissionDigest === "string" &&
		candidate.admissionDigest.length > 0
	);
}

function isCanonicalLeaseRef(value: unknown): value is WorkflowLeaseRef {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkflowLeaseRef>;
	return (
		Number.isSafeInteger(candidate.storeEpoch) &&
		candidate.storeEpoch! > 0 &&
		Number.isSafeInteger(candidate.coordinatorEpoch) &&
		candidate.coordinatorEpoch! > 0 &&
		typeof candidate.leaseId === "string" &&
		candidate.leaseId.length > 0 &&
		Number.isSafeInteger(candidate.acquisitionEventSequence) &&
		candidate.acquisitionEventSequence! > 0 &&
		typeof candidate.processIdentity === "string" &&
		candidate.processIdentity.length > 0 &&
		typeof candidate.rootDigest === "string" &&
		candidate.rootDigest.length > 0 &&
		typeof candidate.writerIdentity === "string" &&
		candidate.writerIdentity.length > 0 &&
		typeof candidate.acquiredAt === "string" &&
		candidate.acquiredAt.length > 0 &&
		typeof candidate.expiresAt === "string" &&
		candidate.expiresAt.length > 0
	);
}

function validateSnapshot(
	invocation: WorkflowEfficiencyRedTeamInvocation,
	token: WorkflowReadOnlyEfficiencyRedTeamToken,
	snapshot: WorkflowEfficiencyRedTeamSnapshot,
): void {
	const invocationCandidate = invocation as Partial<WorkflowEfficiencyRedTeamInvocation>;
	const snapshotCandidate = snapshot as Partial<WorkflowEfficiencyRedTeamSnapshot>;
	const arrayFields: readonly (keyof WorkflowEfficiencyRedTeamSnapshot)[] = [
		"protectedInvariantRefs",
		"costEvidenceRefs",
		"throughputEvidenceRefs",
		"latencyEvidenceRefs",
		"acceptedProgressEvidenceRefs",
		"evidenceGapRefs",
		"uncertaintyEvidenceRefs",
		"liveResourceLeaseRefs",
		"liveOwnershipLeaseRefs",
	];
	if (
		typeof snapshotCandidate.workflowId !== "string" ||
		snapshotCandidate.workflowId.length === 0 ||
		typeof snapshotCandidate.reviewId !== "string" ||
		snapshotCandidate.reviewId.length === 0 ||
		typeof snapshotCandidate.scheduleId !== "string" ||
		snapshotCandidate.scheduleId.length === 0 ||
		arrayFields.some((field) => !Array.isArray(snapshotCandidate[field])) ||
		snapshot.workflowId !== token.workflowId ||
		snapshot.reviewId !== readReviewId(invocation) ||
		typeof snapshot.workflowStateDigest !== "string" ||
		snapshot.workflowStateDigest.length === 0 ||
		typeof snapshot.sourceJournalDigest !== "string" ||
		snapshot.sourceJournalDigest.length === 0 ||
		!Number.isSafeInteger(snapshot.sourceJournalSequence) ||
		snapshot.sourceJournalSequence < 0 ||
		(invocationCandidate.epochRef !== undefined && !sameEpoch(invocationCandidate.epochRef, token.epochRef))
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_digest_mismatch");
	const refsAndDigests: readonly [WorkflowArtifactRef, string][] = [
		[snapshot.originalObjectiveRef, snapshot.originalObjectiveDigest],
		[snapshot.hardenedGoalContractRef, snapshot.hardenedGoalContractDigest],
		[snapshot.scorecardRef, snapshot.scorecardDigest],
		[snapshot.criticalPathCertificateRef, snapshot.criticalPathCertificateDigest],
		[snapshot.configurationRef, snapshot.configurationDigest],
		[snapshot.evaluatorRef, snapshot.evaluatorDigest],
		[snapshot.revisionRegistryRef, snapshot.revisionRegistryDigest],
	];
	const protectedInvariantRefsValid = snapshot.protectedInvariantRefs.every(
		(ref, index) => isCanonicalArtifactRef(ref) && (index !== 0 || ref.digest === snapshot.protectedInvariantDigest),
	);
	const guardValid =
		(snapshot.guardRef === null && snapshot.guardDigest === null) ||
		(snapshot.guardRef !== null &&
			snapshot.guardDigest !== null &&
			isCanonicalArtifactRef(snapshot.guardRef) &&
			snapshot.guardRef.digest === snapshot.guardDigest);
	const { snapshotDigest: _snapshotDigest, snapshotRef: _snapshotRef, ...snapshotContent } = snapshot;
	const proxyEvidenceDigests = new Set([
		...snapshot.throughputEvidenceRefs.map((ref) => ref.digest),
		...snapshot.latencyEvidenceRefs.map((ref) => ref.digest),
	]);
	const evidenceRefs = [
		...snapshot.costEvidenceRefs,
		...snapshot.throughputEvidenceRefs,
		...snapshot.latencyEvidenceRefs,
		...snapshot.acceptedProgressEvidenceRefs,
		...snapshot.evidenceGapRefs,
		...snapshot.uncertaintyEvidenceRefs,
	];
	if (
		refsAndDigests.some(([ref, digest]) => !isCanonicalArtifactRef(ref) || ref.digest !== digest) ||
		!protectedInvariantRefsValid ||
		!guardValid ||
		!isCanonicalArtifactRef(snapshot.planRef) ||
		snapshot.planRef.digest !== snapshot.planDigest ||
		!isCanonicalArtifactRef(snapshot.snapshotRef) ||
		!isCanonicalArtifactRef(invocationCandidate.snapshotRef) ||
		invocationCandidate.snapshotRef.digest !== snapshot.snapshotRef.digest ||
		!isCanonicalArtifactRef(snapshot.publicationEnvelopeRef) ||
		snapshot.publicationEnvelopeRef.digest !== snapshot.publicationEnvelopeDigest ||
		!isCanonicalArtifactRef(snapshot.canonicalPoolLedgerRef) ||
		snapshot.canonicalPoolLedgerRef.digest !== snapshot.canonicalPoolLedgerDigest ||
		snapshot.snapshotDigest !== digestObject(snapshotContent) ||
		!isCanonicalArtifactRef(snapshot.hostDereferenceProofRef) ||
		!snapshot.liveResourceLeaseRefs.every(isCanonicalLeaseRef) ||
		!snapshot.liveOwnershipLeaseRefs.every(isCanonicalLeaseRef) ||
		snapshot.hostDereferenceProofRef.digest.length === 0 ||
		!evidenceRefs.every(isCanonicalArtifactRef) ||
		snapshot.acceptedProgressEvidenceRefs.some((ref) => proxyEvidenceDigests.has(ref.digest))
	)
		throw new WorkflowEfficiencyReviewerError(
			snapshot.acceptedProgressEvidenceRefs.some((ref) => proxyEvidenceDigests.has(ref.digest))
				? "workflow_efficiency_proxy_progress"
				: "workflow_efficiency_snapshot_refs_invalid",
		);
}

async function verifySnapshotArtifacts(
	snapshot: WorkflowEfficiencyRedTeamSnapshot,
	resolver: WorkflowArtifactResolver | undefined,
): Promise<void> {
	if (resolver === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_artifact_resolver_required");
	const refs = [
		snapshot.originalObjectiveRef,
		snapshot.hardenedGoalContractRef,
		snapshot.scorecardRef,
		...snapshot.protectedInvariantRefs,
		snapshot.planRef,
		snapshot.criticalPathCertificateRef,
		snapshot.configurationRef,
		snapshot.evaluatorRef,
		snapshot.guardRef,
		snapshot.revisionRegistryRef,
		snapshot.snapshotRef,
		snapshot.publicationEnvelopeRef,
		snapshot.hostDereferenceProofRef,
		...snapshot.costEvidenceRefs,
		...snapshot.throughputEvidenceRefs,
		...snapshot.latencyEvidenceRefs,
		...snapshot.acceptedProgressEvidenceRefs,
		...snapshot.evidenceGapRefs,
		...snapshot.uncertaintyEvidenceRefs,
		snapshot.canonicalPoolLedgerRef,
	];
	for (const ref of refs) {
		if (ref === null) continue;
		let artifact: WorkflowArtifactReadResult;
		try {
			artifact = await resolver.resolve(ref);
		} catch {
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_artifact_unavailable");
		}
		if (
			!artifact.exists ||
			!artifact.envelope.immutable ||
			digestObject(artifact.envelope.ref) !== digestObject(ref) ||
			artifact.verifiedDigest !== ref.digest ||
			artifact.verifiedSizeBytes !== ref.sizeBytes ||
			artifact.bytes.byteLength !== ref.sizeBytes ||
			sha256Hex(artifact.bytes) !== ref.digest
		)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_artifact_invalid");
	}
}

function bytesEqual(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function verifyScheduleArtifacts(
	schedule: WorkflowEfficiencyReviewSchedule,
	manifestRef: WorkflowArtifactRef,
	resolver: WorkflowArtifactResolver,
): Promise<void> {
	if (!isCanonicalArtifactRef(manifestRef) || manifestRef.digest !== schedule.scheduleDigest)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_manifest_invalid");
	const expectedManifestBytes = canonicalJsonBytes(scheduleImmutableFields(schedule));
	let manifest: WorkflowArtifactReadResult;
	try {
		manifest = await resolver.resolve(manifestRef);
	} catch {
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_manifest_unavailable");
	}
	if (
		!manifest.exists ||
		!manifest.envelope.immutable ||
		digestObject(manifest.envelope.ref) !== digestObject(manifestRef) ||
		manifest.verifiedDigest !== manifestRef.digest ||
		manifest.verifiedSizeBytes !== manifestRef.sizeBytes ||
		manifest.bytes.byteLength !== manifestRef.sizeBytes ||
		sha256Hex(manifest.bytes) !== manifestRef.digest ||
		!bytesEqual(manifest.bytes, expectedManifestBytes)
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_manifest_invalid");

	const resourceAdmission = schedule.reviewResourceAdmission as {
		canonicalPoolLedgerRef?: WorkflowArtifactRef;
		canonicalLedgerRef?: WorkflowArtifactRef;
		capacityGrant?: { canonicalPoolLedgerRef?: WorkflowArtifactRef };
	};
	const refs = [
		schedule.trustedClockSourceRef,
		schedule.resourceEnvelopeRef,
		schedule.capacityRegistryRef,
		schedule.clockObservationRef,
		schedule.approvalReceipt.artifactRef,
		schedule.reserveLedgerRef,
		resourceAdmission.canonicalPoolLedgerRef,
		resourceAdmission.canonicalLedgerRef,
		resourceAdmission.capacityGrant?.canonicalPoolLedgerRef,
	];
	for (const ref of refs) {
		if (ref === undefined) continue;
		let artifact: WorkflowArtifactReadResult;
		try {
			artifact = await resolver.resolve(ref);
		} catch {
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_artifact_unavailable");
		}
		if (
			!artifact.exists ||
			!artifact.envelope.immutable ||
			digestObject(artifact.envelope.ref) !== digestObject(ref) ||
			artifact.verifiedDigest !== ref.digest ||
			artifact.verifiedSizeBytes !== ref.sizeBytes ||
			artifact.bytes.byteLength !== ref.sizeBytes ||
			sha256Hex(artifact.bytes) !== ref.digest
		)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_artifact_invalid");
	}
}

function dueWindowId(schedule: WorkflowEfficiencyReviewSchedule): string {
	return `${schedule.scheduleId}:${schedule.revision}:${schedule.nextDueAt}`;
}

function validSchedule(schedule: WorkflowEfficiencyReviewSchedule): boolean {
	if (typeof schedule !== "object" || schedule === null) return false;
	if (typeof schedule.epochRef !== "object" || schedule.epochRef === null) return false;
	const positiveFields: readonly number[] = [
		schedule.minimumCadenceMilliseconds,
		schedule.maximumCadenceMilliseconds,
		schedule.overheadBudgetMicrounits,
		schedule.idempotencyWindowMilliseconds,
		schedule.dutyCycleCapMicrounits,
		schedule.perWindowOverheadCapMicrounits,
		schedule.perPhaseOverheadCapMicrounits,
		schedule.perWorkflowOverheadCapMicrounits,
		schedule.wallCeilingMilliseconds,
		schedule.tokenCeiling,
		schedule.costCeilingMicrounits,
		schedule.cadenceMilliseconds,
		schedule.maxReviewsPerPhase,
		schedule.maxReviewsPerWorkflow,
		schedule.dutyCycleCapPermille,
		schedule.maxReviewWallMilliseconds,
		schedule.maxReviewTokens,
		schedule.maxReviewCostMicrounits,
	];
	const valid =
		typeof schedule.workflowId === "string" &&
		schedule.workflowId.length > 0 &&
		typeof schedule.scheduleId === "string" &&
		schedule.scheduleId.length > 0 &&
		Number.isSafeInteger(schedule.revision) &&
		schedule.revision > 0 &&
		Number.isSafeInteger(schedule.epochRef.storeEpoch) &&
		schedule.epochRef.storeEpoch > 0 &&
		Number.isSafeInteger(schedule.epochRef.coordinatorEpoch) &&
		schedule.epochRef.coordinatorEpoch > 0 &&
		positiveFields.every(isFinitePositive) &&
		validControlCapacity(schedule.dedicatedControlReserve) &&
		reservePartitionsFit(schedule) &&
		isCommittedDecisionRef(schedule.approvedDecisionRef, schedule.workflowId, schedule.epochRef) &&
		isCommittedApprovalReceipt(schedule.approvalReceipt, schedule.workflowId, schedule.revision) &&
		isCommittedResourceAdmission(schedule.reviewResourceAdmission) &&
		resourceAdmissionLedgerMatches(schedule) &&
		isCanonicalArtifactRef(schedule.reserveLedgerRef) &&
		schedule.reserveLedgerRef.digest === schedule.reserveLedgerDigest &&
		schedule.reserveLedgerDigest.length > 0 &&
		typeof schedule.scheduleDigest === "string" &&
		schedule.scheduleDigest.length > 0 &&
		typeof schedule.scheduleBoundsDigest === "string" &&
		schedule.scheduleBoundsDigest.length > 0 &&
		isCanonicalArtifactRef(schedule.trustedClockSourceRef) &&
		isCanonicalArtifactRef(schedule.resourceEnvelopeRef) &&
		schedule.resourceEnvelopeRef.digest === schedule.approvedResourceEnvelopeDigest &&
		isCanonicalArtifactRef(schedule.capacityRegistryRef) &&
		isCanonicalArtifactRef(schedule.clockObservationRef) &&
		typeof schedule.approvedResourceEnvelopeDigest === "string" &&
		schedule.approvedResourceEnvelopeDigest.length > 0 &&
		typeof schedule.trustedClockSourceDigest === "string" &&
		schedule.trustedClockSourceDigest.length > 0 &&
		schedule.trustedClockSourceRef.digest === schedule.trustedClockSourceDigest &&
		Number.isSafeInteger(schedule.lastAdmittedWindowSequence) &&
		schedule.lastAdmittedWindowSequence >= 0 &&
		(schedule.lastAdmittedWindowId === null ||
			(typeof schedule.lastAdmittedWindowId === "string" && schedule.lastAdmittedWindowId.length > 0)) &&
		schedule.dedicatedControlReserve.processSlots > 0 &&
		schedule.dedicatedControlReserve.verificationSlots > 0 &&
		schedule.dedicatedControlReserve.redTeamSlots > 0 &&
		schedule.minimumCadenceMilliseconds <= schedule.cadenceMilliseconds &&
		schedule.cadenceMilliseconds <= schedule.maximumCadenceMilliseconds &&
		schedule.maxReviewsPerWindow === 1 &&
		schedule.overlapPolicy === "reject" &&
		schedule.catchUpAfterRestart === "one" &&
		(schedule.status === "scheduled" || schedule.status === "started" || schedule.status === "recovered") &&
		Number.isFinite(Date.parse(schedule.nextDueAt)) &&
		Array.isArray(schedule.triggerSet) &&
		schedule.triggerSet.length > 0 &&
		schedule.triggerSet.every((trigger) => VALID_TRIGGER_KINDS.has(trigger)) &&
		Array.isArray(schedule.majorTransitionTriggers) &&
		schedule.majorTransitionTriggers.every((trigger) => VALID_TRIGGER_KINDS.has(trigger));
	return valid;
}

function approvedScheduleMatches(
	schedule: WorkflowEfficiencyReviewSchedule,
	approved: WorkflowEfficiencyReviewSchedule,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): boolean {
	return (
		schedule.workflowId === workflowId &&
		approved.workflowId === workflowId &&
		schedule.scheduleId === approved.scheduleId &&
		schedule.revision === approved.revision &&
		schedule.scheduleDigest === approved.scheduleDigest &&
		schedule.scheduleDigest === workflowEfficiencyReviewScheduleDigest(schedule) &&
		approved.scheduleDigest === workflowEfficiencyReviewScheduleDigest(approved) &&
		sameEpoch(schedule.epochRef, epochRef) &&
		sameEpoch(approved.epochRef, epochRef)
	);
}

function fitsOverheadReserve(required: WorkflowResourceVector, available: WorkflowResourceVector): boolean {
	return (
		RESOURCE_FIELDS.every((field) => required[field] <= available[field]) &&
		required.accelerators.every((needed) => {
			const pool = available.accelerators.find((candidate) => candidate.poolId === needed.poolId);
			return pool !== undefined && pool.count >= needed.count && pool.memoryBytes >= needed.memoryBytes;
		}) &&
		required.providers.every((needed) => {
			const pool = available.providers.find((candidate) => candidate.poolId === needed.poolId);
			return (
				pool !== undefined &&
				pool.concurrentRequests >= needed.concurrentRequests &&
				pool.requestsPerMinute >= needed.requestsPerMinute &&
				pool.totalRequests >= needed.totalRequests &&
				pool.inputTokens >= needed.inputTokens &&
				pool.outputTokens >= needed.outputTokens
			);
		})
	);
}

function isFiniteResourceVector(value: unknown): value is WorkflowResourceVector {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkflowResourceVector>;
	return (
		RESOURCE_FIELDS.every(
			(field) => typeof candidate[field] === "number" && Number.isFinite(candidate[field]) && candidate[field] >= 0,
		) &&
		Array.isArray(candidate.accelerators) &&
		candidate.accelerators.every(
			(pool) =>
				typeof pool === "object" &&
				pool !== null &&
				typeof pool.poolId === "string" &&
				typeof pool.deviceType === "string" &&
				Number.isFinite(pool.count) &&
				pool.count >= 0 &&
				Number.isFinite(pool.memoryBytes) &&
				pool.memoryBytes >= 0,
		) &&
		Array.isArray(candidate.providers) &&
		candidate.providers.every(
			(pool) =>
				typeof pool === "object" &&
				pool !== null &&
				typeof pool.poolId === "string" &&
				Number.isFinite(pool.concurrentRequests) &&
				pool.concurrentRequests >= 0 &&
				Number.isFinite(pool.requestsPerMinute) &&
				pool.requestsPerMinute >= 0 &&
				Number.isFinite(pool.totalRequests) &&
				pool.totalRequests >= 0 &&
				Number.isFinite(pool.inputTokens) &&
				pool.inputTokens >= 0 &&
				Number.isFinite(pool.outputTokens) &&
				pool.outputTokens >= 0,
		)
	);
}

function reviewResourceVector(schedule: WorkflowEfficiencyReviewSchedule): WorkflowResourceVector | null {
	const candidate = schedule.reviewResourceAdmission as { reservedVector?: unknown };
	return isFiniteResourceVector(candidate.reservedVector) ? candidate.reservedVector : null;
}

async function readUsage(
	reader:
		| (() => Promise<WorkflowResourceVector>)
		| ((invocation: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowResourceVector>),
	invocation: WorkflowEfficiencyRedTeamInvocation,
): Promise<WorkflowResourceVector> {
	const callable = reader as (invocation?: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowResourceVector>;
	return reader.length === 0 ? callable() : callable(invocation);
}

function providerTokenCount(vector: WorkflowResourceVector): number {
	return vector.providers.reduce((total, provider) => total + provider.inputTokens + provider.outputTokens, 0);
}

function fitsReviewBudget(
	usage: unknown,
	schedule: WorkflowEfficiencyReviewSchedule,
	overheadReserve: WorkflowResourceVector | undefined,
): usage is WorkflowResourceVector {
	if (!isFiniteResourceVector(usage)) return false;
	const declaredReserve = reviewResourceVector(schedule);
	if (declaredReserve !== null && !fitsOverheadReserve(usage, declaredReserve)) return false;
	if (overheadReserve !== undefined && !fitsOverheadReserve(usage, overheadReserve)) return false;
	const monetaryCeiling = Math.min(
		schedule.overheadBudgetMicrounits,
		schedule.dutyCycleCapMicrounits,
		schedule.perWindowOverheadCapMicrounits,
		schedule.perPhaseOverheadCapMicrounits,
		schedule.perWorkflowOverheadCapMicrounits,
		schedule.costCeilingMicrounits,
		schedule.maxReviewCostMicrounits,
	);
	const wallCeiling = Math.min(schedule.wallCeilingMilliseconds, schedule.maxReviewWallMilliseconds);
	const tokenCeiling = Math.min(schedule.tokenCeiling, schedule.maxReviewTokens);
	return (
		usage.wallMilliseconds <= wallCeiling &&
		usage.monetaryMicrounits <= monetaryCeiling &&
		providerTokenCount(usage) <= tokenCeiling
	);
}

function resultDigest(result: WorkflowEfficiencyRedTeamResult): string {
	const { resultDigest: _resultDigest, ...preimage } = result;
	return digestObject(preimage);
}

function sameReplayEpoch(value: unknown, epochRef: WorkflowEpochRef): boolean {
	return isEfficiencyEpochRef(value) && sameEpoch(value, epochRef);
}

function replayHeadPrecedes(expectedHead: unknown, currentHead: unknown): boolean {
	if (!isEfficiencyRecord(expectedHead) || !isEfficiencyRecord(currentHead)) return false;
	const expectedSequence = expectedHead.sequence;
	const currentSequence = currentHead.sequence;
	if (
		typeof expectedSequence !== "number" ||
		typeof currentSequence !== "number" ||
		!Number.isSafeInteger(expectedSequence) ||
		!Number.isSafeInteger(currentSequence)
	)
		return false;
	return (
		currentSequence > expectedSequence &&
		(expectedHead.workflowId === undefined || expectedHead.workflowId === currentHead.workflowId) &&
		(expectedHead.epochRef === undefined ||
			(isEfficiencyEpochRef(currentHead.epochRef) && sameReplayEpoch(expectedHead.epochRef, currentHead.epochRef)))
	);
}

function findReplayResult(
	events: readonly unknown[],
	windowId: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	scheduleDigest: string,
	head: unknown,
): WorkflowEfficiencyRedTeamResult | null {
	for (const event of events) {
		if (typeof event !== "object" || event === null) continue;
		const payload = (event as { payload?: unknown }).payload;
		if (typeof payload !== "object" || payload === null) continue;
		const candidate = payload as {
			kind?: unknown;
			workflowId?: unknown;
			epochRef?: unknown;
			dueWindowId?: unknown;
			scheduleDigest?: unknown;
			expectedHead?: unknown;
			expectedHeadDigest?: unknown;
			hostMeasuredUsage?: unknown;
			result?: unknown;
			report?: { dueWindowId?: unknown; exactResult?: unknown };
		};
		if (candidate.kind !== "efficiency_red_team_completed") continue;
		const envelope = event as {
			workflowId?: unknown;
			epochRef?: unknown;
			sequence?: unknown;
			eventDigest?: unknown;
			expectedHead?: unknown;
		};
		const currentHead = head as {
			workflowId?: unknown;
			epochRef?: unknown;
			sequence?: unknown;
			eventDigest?: unknown;
		};
		if (
			candidate.dueWindowId !== windowId ||
			candidate.workflowId !== workflowId ||
			!sameReplayEpoch(candidate.epochRef, epochRef) ||
			(currentHead.workflowId !== undefined && currentHead.workflowId !== workflowId) ||
			(currentHead.epochRef !== undefined && !sameReplayEpoch(currentHead.epochRef, epochRef)) ||
			(envelope.workflowId !== undefined && envelope.workflowId !== workflowId) ||
			(envelope.epochRef !== undefined && !sameReplayEpoch(envelope.epochRef, epochRef)) ||
			candidate.scheduleDigest !== scheduleDigest ||
			typeof candidate.expectedHead !== "object" ||
			candidate.expectedHead === null ||
			!replayHeadPrecedes(candidate.expectedHead, head) ||
			candidate.expectedHeadDigest !== digestObject(candidate.expectedHead) ||
			(envelope.expectedHead !== undefined &&
				digestObject(envelope.expectedHead) !== digestObject(candidate.expectedHead)) ||
			(envelope.sequence !== undefined &&
				(typeof currentHead.sequence !== "number" || envelope.sequence !== currentHead.sequence)) ||
			(envelope.eventDigest !== undefined && envelope.eventDigest !== currentHead.eventDigest) ||
			!isResult(candidate.result) ||
			candidate.result.resultDigest !== resultDigest(candidate.result) ||
			!isFiniteResourceVector(candidate.hostMeasuredUsage) ||
			digestObject(candidate.hostMeasuredUsage) !== digestObject(candidate.result.actualUsage)
		)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_replay_invalid");
		return candidate.result;
	}
	return null;
}

function replayHasStarted(
	events: readonly unknown[],
	windowId: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	scheduleDigest: string,
): boolean {
	return events.some((event) => {
		if (typeof event !== "object" || event === null) return false;
		const payload = (event as { payload?: unknown }).payload;
		if (typeof payload !== "object" || payload === null) return false;
		const candidate = payload as {
			kind?: unknown;
			workflowId?: unknown;
			epochRef?: unknown;
			dueWindowId?: unknown;
			scheduleDigest?: unknown;
		};
		return (
			candidate.kind === "efficiency_red_team_started" &&
			candidate.workflowId === workflowId &&
			sameReplayEpoch(candidate.epochRef, epochRef) &&
			candidate.dueWindowId === windowId &&
			candidate.scheduleDigest === scheduleDigest
		);
	});
}

function replayHasCatchUpConsumed(
	events: readonly unknown[],
	windowId: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	scheduleDigest: string,
): boolean {
	return events.some((event) => {
		if (typeof event !== "object" || event === null) return false;
		const payload = (event as { payload?: unknown }).payload;
		if (typeof payload !== "object" || payload === null) return false;
		const candidate = payload as {
			kind?: unknown;
			workflowId?: unknown;
			epochRef?: unknown;
			dueWindowId?: unknown;
			scheduleDigest?: unknown;
		};
		return (
			candidate.kind === "efficiency_red_team_catch_up_consumed" &&
			candidate.workflowId === workflowId &&
			sameReplayEpoch(candidate.epochRef, epochRef) &&
			candidate.dueWindowId === windowId &&
			candidate.scheduleDigest === scheduleDigest
		);
	});
}

function isResult(value: unknown): value is WorkflowEfficiencyRedTeamResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		kind?: unknown;
		reviewId?: unknown;
		resultDigest?: unknown;
		actualUsage?: unknown;
	};
	return (
		(candidate.kind === "success" || candidate.kind === "failure") &&
		typeof candidate.reviewId === "string" &&
		typeof candidate.resultDigest === "string" &&
		isFiniteResourceVector(candidate.actualUsage)
	);
}

function isEfficiencySuggestion(value: unknown): value is WorkflowEfficiencyRedTeamSuggestion {
	if (!isEfficiencyRecord(value)) return false;
	return (
		typeof value.suggestionId === "string" &&
		typeof value.reviewId === "string" &&
		typeof value.windowId === "string" &&
		[
			"no_change",
			"suggest_reallocation",
			"suggest_schedule_change",
			"suggest_user_decision",
			"safety_finding",
		].includes(String(value.disposition)) &&
		Array.isArray(value.findingRefs) &&
		value.findingRefs.every(isCanonicalArtifactRef) &&
		Array.isArray(value.evidenceRefs) &&
		value.evidenceRefs.every(isCanonicalArtifactRef) &&
		(value.recommendedAllocationRef === null || isCanonicalArtifactRef(value.recommendedAllocationRef)) &&
		(value.expectedVerifiedOutcomeRef === null || isCanonicalArtifactRef(value.expectedVerifiedOutcomeRef)) &&
		value.writeAuthority === false &&
		value.leaseAuthority === false &&
		value.allocationAuthority === false &&
		value.approvalAuthority === false &&
		value.completionAuthority === false &&
		typeof value.suggestionDigest === "string" &&
		value.suggestionDigest.length > 0
	);
}

function isEfficiencyReallocationConsumerResult(value: unknown): value is WorkflowEfficiencyReallocationConsumerResult {
	if (!isEfficiencyRecord(value)) return false;
	return (
		(value.disposition === "accepted" ||
			value.disposition === "already_consumed" ||
			value.disposition === "rejected") &&
		typeof value.operationId === "string" &&
		value.operationId.length > 0
	);
}

function isEfficiencyReallocationProposal(value: unknown): value is WorkflowEfficiencyReallocationProposal {
	if (!isEfficiencyRecord(value)) return false;
	return (
		typeof value.workflowId === "string" &&
		isEfficiencyEpochRef(value.epochRef) &&
		typeof value.dueWindowId === "string" &&
		isEfficiencyJournalHead(value.sourceHead) &&
		isResult(value.result) &&
		value.result.kind === "success" &&
		isEfficiencySuggestion(value.suggestion) &&
		typeof value.invocationTokenDigest === "string" &&
		value.invocationTokenDigest.length > 0 &&
		typeof value.reportDigest === "string" &&
		value.reportDigest.length > 0
	);
}

function actionableReallocationFromBoundary(
	payload: unknown,
	append: WorkflowEfficiencyBoundaryAppendInput,
	result: WorkflowEfficiencyRedTeamResult,
): WorkflowEfficiencyReallocationProposal | null {
	if (result.kind !== "success") return null;
	if (!isEfficiencyRecord(payload) || payload.kind !== "efficiency_red_team_completed")
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	if (!isEfficiencyRecord(payload.report))
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	if (!isEfficiencyJournalHead(append.expectedHead))
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_head_required");
	const report = payload.report;
	if (
		report.workflowId !== append.workflowId ||
		report.dueWindowId !== append.dueWindowId ||
		!isEfficiencyEpochRef(report.epochRef) ||
		!sameEpoch(report.epochRef, append.epochRef) ||
		report.kind !== "success" ||
		report.resultDigest !== result.resultDigest ||
		!isResult(report.exactResult) ||
		report.exactResult.kind !== "success" ||
		report.exactResult.resultDigest !== result.resultDigest ||
		report.sourceJournalSequence !== append.expectedHead.sequence ||
		report.sourceJournalDigest !== append.expectedHead.eventDigest ||
		typeof report.invocationTokenDigest !== "string" ||
		report.invocationTokenDigest.length === 0 ||
		report.disposition !== "suggest_reallocation" ||
		report.writeAuthority !== false ||
		report.reallocationAuthority !== false ||
		report.approvalAuthority !== false ||
		!Array.isArray(report.suggestions) ||
		!report.suggestions.every(isEfficiencySuggestion) ||
		typeof report.reportDigest !== "string" ||
		report.reportDigest.length === 0
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	const reportPreimage = { ...report, reportDigest: "" };
	if (digestObject(reportPreimage) !== report.reportDigest)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	const suggestion = report.suggestions.find((candidate) => candidate.disposition === "suggest_reallocation");
	if (suggestion === undefined) return null;
	if (suggestion.recommendedAllocationRef === null || suggestion.expectedVerifiedOutcomeRef === null)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	const suggestionPreimage = { ...suggestion, suggestionDigest: "" };
	if (digestObject(suggestionPreimage) !== suggestion.suggestionDigest)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_report_invalid");
	const proposal: WorkflowEfficiencyReallocationProposal = {
		workflowId: append.workflowId,
		epochRef: append.epochRef,
		dueWindowId: append.dueWindowId,
		sourceHead: append.expectedHead,
		result: report.exactResult,
		suggestion,
		invocationTokenDigest: report.invocationTokenDigest,
		reportDigest: report.reportDigest,
	};
	return proposal;
}

function failureResult(
	invocation: WorkflowEfficiencyRedTeamInvocation,
	status: "failed" | "timed_out" | "stale" | "unavailable" | "fenced",
	completedAt: string,
	actualUsage: WorkflowResourceVector = readInvocationUsage(invocation),
): WorkflowEfficiencyRedTeamResult {
	const reviewId = readReviewId(invocation);
	const result = {
		kind: "failure" as const,
		reviewId,
		invocationRef: invocationRef(invocation),
		status,
		errorRef: artifactRef(`efficiency-review-error-${reviewId}`),
		actualUsage,
		completedAt,
		resultDigest: "",
	};
	const { resultDigest: _unusedResultDigest, ...preimage } = result;
	return { ...result, resultDigest: digestObject(preimage) };
}

function failureResultForWindow(
	windowId: string,
	status: "failed" | "timed_out" | "stale" | "unavailable" | "fenced",
	completedAt: string,
	actualUsage: WorkflowResourceVector,
): WorkflowEfficiencyRedTeamResult {
	const reviewId = `review-${windowId}`;
	const result = {
		kind: "failure" as const,
		reviewId,
		invocationRef: artifactRef(`invocation-${reviewId}`),
		status,
		errorRef: artifactRef(`efficiency-review-error-${reviewId}`),
		actualUsage,
		completedAt,
		resultDigest: "",
	};
	const { resultDigest: _unusedResultDigest, ...preimage } = result;
	return { ...result, resultDigest: digestObject(preimage) };
}

/**
 * Create a reviewer that can inspect canonical evidence but has no effect or dispatch capability.
 *
 * Args:
 * dependencies: Read-only evidence port and trusted clock.
 * Return: Reviewer which emits a proposal result without applying it.
 */
export function createWorkflowEfficiencyRedTeamReviewer(
	dependencies: WorkflowEfficiencyRedTeamReviewerDependencies,
): WorkflowEfficiencyRedTeamReviewer {
	return {
		review: async (invocation, token) => {
			if (!isValidReadOnlyToken(token))
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_read_only_token_invalid");
			const invocationCandidate = invocation as Partial<WorkflowEfficiencyRedTeamInvocation>;
			if (invocationCandidate.actualUsage === undefined)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_usage_unavailable");
			const invocationUsage = readInvocationUsage(invocation);
			if (
				!isFiniteResourceVector(invocationUsage) ||
				invocationUsage.wallMilliseconds > token.remainingWallMilliseconds ||
				providerTokenCount(invocationUsage) > token.remainingTokens
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_read_only_token_exhausted");
			const snapshot = await dependencies.readPort.readSnapshot(token);
			validateSnapshot(invocation, token, snapshot);
			await verifySnapshotArtifacts(snapshot, dependencies.artifactResolver);
			if (snapshot.snapshotDigest !== token.snapshotDigest)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_stale");
			await dependencies.readPort.readJournalSlice(token, snapshot.sourceJournalSequence, 256);
			await dependencies.readPort.readEvidenceRefs(token);
			await dependencies.readPort.readCapacityObservation(token);
			const reviewId = readReviewId(invocation);
			const result = {
				kind: "success" as const,
				reviewId,
				invocationRef: invocationRef(invocation),
				suggestionRef: artifactRef(`efficiency-review-suggestion-${reviewId}`),
				actualUsage: invocationUsage,
				completedAt: dependencies.trustedNow(),
				resultDigest: "",
			};
			const { resultDigest: _unusedResultDigest, ...preimage } = result;
			return { ...result, resultDigest: digestObject(preimage) };
		},
	};
}

const EFFICIENCY_RUNTIME_AUXILIARY_RECORD = "workflow-efficiency-runtime-state.json";

interface PersistedEfficiencyWindow {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	dueWindowId: string;
	scheduleDigest: string;
	catchUp: boolean;
	expectedHead: WorkflowJournalHead | null;
	hostMeasuredUsage: WorkflowResourceVector | null;
	result: WorkflowEfficiencyRedTeamResult | null;
	reallocationProposal: WorkflowEfficiencyReallocationProposal | null;
	reallocationConsumption: WorkflowEfficiencyReallocationConsumerResult | null;
}

interface PersistedEfficiencyRuntimeState {
	version: 1;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	windows: Readonly<Record<string, PersistedEfficiencyWindow>>;
	consumedTokens: Readonly<Record<string, true>>;
}

function isPersistedEfficiencyWindow(value: unknown): value is PersistedEfficiencyWindow {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<PersistedEfficiencyWindow>;
	return (
		typeof candidate.workflowId === "string" &&
		candidate.workflowId.length > 0 &&
		isEfficiencyEpochRef(candidate.epochRef) &&
		typeof candidate.dueWindowId === "string" &&
		candidate.dueWindowId.length > 0 &&
		typeof candidate.scheduleDigest === "string" &&
		candidate.scheduleDigest.length > 0 &&
		typeof candidate.catchUp === "boolean" &&
		(candidate.expectedHead === null || isEfficiencyJournalHead(candidate.expectedHead)) &&
		(candidate.hostMeasuredUsage === null || isFiniteResourceVector(candidate.hostMeasuredUsage)) &&
		(candidate.result === null || isResult(candidate.result)) &&
		(candidate.reallocationProposal === null || isEfficiencyReallocationProposal(candidate.reallocationProposal)) &&
		(candidate.reallocationConsumption === null ||
			isEfficiencyReallocationConsumerResult(candidate.reallocationConsumption))
	);
}

function isPersistedEfficiencyRuntimeState(
	value: unknown,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): value is PersistedEfficiencyRuntimeState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<PersistedEfficiencyRuntimeState>;
	if (
		candidate.version !== 1 ||
		candidate.workflowId !== workflowId ||
		!isEfficiencyEpochRef(candidate.epochRef) ||
		!sameEpoch(candidate.epochRef, epochRef) ||
		typeof candidate.windows !== "object" ||
		candidate.windows === null ||
		Array.isArray(candidate.windows) ||
		typeof candidate.consumedTokens !== "object" ||
		candidate.consumedTokens === null ||
		Array.isArray(candidate.consumedTokens)
	)
		return false;
	return (
		Object.values(candidate.windows).every(
			(window) =>
				isPersistedEfficiencyWindow(window) &&
				window.workflowId === workflowId &&
				sameEpoch(window.epochRef, epochRef),
		) && Object.values(candidate.consumedTokens).every((token) => token === true)
	);
}

function normalizePersistedEfficiencyRuntimeState(
	state: PersistedEfficiencyRuntimeState,
	epochRef: WorkflowEpochRef,
	schedule: WorkflowEfficiencyReviewSchedule,
): PersistedEfficiencyRuntimeState {
	if (sameEpoch(state.epochRef, epochRef)) return state;
	if (state.epochRef.storeEpoch !== epochRef.storeEpoch || state.epochRef.coordinatorEpoch > epochRef.coordinatorEpoch)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_epoch_invalid");
	const windows: Record<string, PersistedEfficiencyWindow> = {};
	for (const [key, window] of Object.entries(state.windows)) {
		if (!window.dueWindowId.startsWith(`${schedule.scheduleId}:${schedule.revision}:`))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_schedule_mismatch");
		const expectedHead =
			window.expectedHead === null
				? null
				: {
						...window.expectedHead,
						epochRef,
					};
		windows[key] = {
			...window,
			epochRef,
			scheduleDigest: schedule.scheduleDigest,
			expectedHead,
		};
	}
	return {
		...state,
		epochRef,
		windows,
	};
}

function recoverPersistedEfficiencyRuntimeStateFromReplay(
	replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	schedule: WorkflowEfficiencyReviewSchedule,
): PersistedEfficiencyRuntimeState | null {
	const windows: Record<string, PersistedEfficiencyWindow> = {};
	for (const event of replay.events) {
		const payload = event.payload;
		if (!isEfficiencyRecord(payload) || payload.kind !== "efficiency_red_team_completed") continue;
		if (payload.workflowId !== workflowId || !isEfficiencyRecord(payload.report)) continue;
		const report = payload.report;
		if (typeof report.dueWindowId !== "string" || !isResult(report.exactResult)) continue;
		const expectedHead: WorkflowJournalHead = { ...event.expectedHead, epochRef };
		const recoveredProposal =
			report.exactResult.kind === "success"
				? actionableReallocationFromBoundary(
						payload,
						{
							eventKind: "efficiency_red_team_completed",
							workflowId,
							epochRef: event.epochRef,
							dueWindowId: report.dueWindowId,
							expectedHead: event.expectedHead,
							schedule,
						},
						report.exactResult,
					)
				: null;
		const reallocationProposal =
			recoveredProposal === null
				? null
				: {
						...recoveredProposal,
						epochRef,
						sourceHead: expectedHead,
					};
		const key = efficiencyWindowStoreKey(workflowId, epochRef, report.dueWindowId, schedule.scheduleDigest);
		windows[key] = {
			workflowId,
			epochRef,
			dueWindowId: report.dueWindowId,
			scheduleDigest: schedule.scheduleDigest,
			catchUp: false,
			expectedHead,
			hostMeasuredUsage: report.exactResult.actualUsage,
			result: report.exactResult,
			reallocationProposal,
			reallocationConsumption: null,
		};
	}
	if (Object.keys(windows).length === 0) return null;
	const consumedTokens: Record<string, true> = {};
	for (const window of Object.values(windows)) {
		consumedTokens[
			efficiencyTokenStoreKey(
				workflowId,
				epochRef,
				`efficiency-token-${window.dueWindowId}`,
				window.dueWindowId,
				schedule.scheduleDigest,
			)
		] = true;
	}
	return {
		version: 1,
		workflowId,
		epochRef,
		windows,
		consumedTokens,
	};
}

function efficiencyWindowStoreKey(
	workflowId: string,
	epochRef: WorkflowEpochRef,
	dueWindowId: string,
	scheduleDigest: string,
): string {
	return digestObject({ workflowId, epochRef, dueWindowId, scheduleDigest });
}

function efficiencyTokenStoreKey(
	workflowId: string,
	epochRef: WorkflowEpochRef,
	tokenId: string,
	dueWindowId: string,
	scheduleDigest: string,
): string {
	return digestObject({ workflowId, epochRef, tokenId, dueWindowId, scheduleDigest });
}

/**
 * Compose the production efficiency runtime over one authenticated workflow store.
 *
 * Args:
 * input: Durable runtime store and host-owned read, review, invocation, and append ports.
 * Return: Event-driven efficiency runtime with durable window and token CAS state.
 */
export function createWorkflowEfficiencyRedTeamRuntimeForStore(
	input: WorkflowEfficiencyRedTeamRuntimeFactoryInput,
): WorkflowEfficiencyRedTeamRuntime {
	if (typeof input !== "object" || input === null)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_runtime_factory_input_required");
	if (
		!(input.hostAuthority instanceof WorkflowEfficiencyRedTeamHostAuthority) ||
		!issuedEfficiencyRedTeamHostAuthorities.has(input.hostAuthority)
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_host_authority_required");
	const runtimeStore = input.hostAuthority.runtimeStore;
	const durableContext = input.hostAuthority.durableContext;
	if (
		typeof runtimeStore.replay !== "function" ||
		typeof runtimeStore.identity !== "object" ||
		runtimeStore.identity === null ||
		typeof runtimeStore.identity.workflowId !== "string"
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_runtime_store_required");
	if (
		typeof input.approvedSchedule !== "object" ||
		input.approvedSchedule === null ||
		runtimeStore.identity.workflowId !== input.approvedSchedule.workflowId ||
		input.hostAuthority.workflowId !== input.approvedSchedule.workflowId
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_runtime_store_workflow_mismatch");
	if (!validSchedule(input.approvedSchedule))
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_invalid");
	if (
		typeof durableContext !== "object" ||
		durableContext === null ||
		typeof durableContext.auxiliaryStore !== "object" ||
		durableContext.auxiliaryStore === null ||
		typeof durableContext.auxiliaryStore.read !== "function" ||
		typeof durableContext.auxiliaryStore.write !== "function" ||
		typeof durableContext.withExclusiveLease !== "function" ||
		typeof durableContext.epochRef !== "object" ||
		durableContext.epochRef === null
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_durable_context_required");
	if (!sameEpoch(durableContext.epochRef, input.approvedSchedule.epochRef))
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_durable_context_epoch_mismatch");
	if (
		typeof input.readPort !== "object" ||
		input.readPort === null ||
		typeof input.reviewer !== "object" ||
		input.reviewer === null ||
		typeof input.readPort.readSnapshot !== "function" ||
		typeof input.readPort.readJournalSlice !== "function" ||
		typeof input.readPort.readEvidenceRefs !== "function" ||
		typeof input.readPort.readCapacityObservation !== "function" ||
		typeof input.reviewer.review !== "function" ||
		typeof input.scheduleArtifactResolver !== "object" ||
		input.scheduleArtifactResolver === null ||
		typeof input.scheduleArtifactResolver.resolve !== "function" ||
		typeof input.snapshotArtifactResolver !== "object" ||
		input.snapshotArtifactResolver === null ||
		typeof input.snapshotArtifactResolver.resolve !== "function" ||
		!isCanonicalArtifactRef(input.scheduleManifestRef)
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_host_ports_required");
	if (
		typeof input.trustedNow !== "function" ||
		typeof input.trustedMonotonicNow !== "function" ||
		typeof input.readActiveLeaseContext !== "function" ||
		typeof input.rootHostAppendBoundary !== "function" ||
		typeof input.snapshotResolver !== "function" ||
		typeof input.reviewInvocationFactory !== "function" ||
		typeof input.readOnlyCapabilityProofResolver !== "function" ||
		typeof input.readUsage !== "function" ||
		typeof input.readRevisionBoundaryContext !== "function" ||
		typeof input.revisionRegistry !== "object" ||
		input.revisionRegistry === null ||
		typeof input.revisionRegistry.assertActive !== "function"
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_host_authority_required");
	if (
		typeof input.reallocationConsumer !== "object" ||
		input.reallocationConsumer === null ||
		typeof input.reallocationConsumer.consume !== "function"
	)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_consumer_required");

	const persistRecoveredState = async (
		state: PersistedEfficiencyRuntimeState,
	): Promise<PersistedEfficiencyRuntimeState> => {
		let recoveredState = state;
		for (const [key, window] of Object.entries(state.windows)) {
			if (window.reallocationProposal === null || window.reallocationConsumption !== null) continue;
			let consumption: WorkflowEfficiencyReallocationConsumerResult;
			try {
				consumption = await input.reallocationConsumer.consume(window.reallocationProposal);
			} catch {
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_consumer_unavailable");
			}
			if (!isEfficiencyReallocationConsumerResult(consumption))
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_consumer_invalid");
			if (consumption.disposition === "rejected")
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_rejected");
			recoveredState = {
				...recoveredState,
				windows: {
					...recoveredState.windows,
					[key]: { ...window, reallocationConsumption: consumption },
				},
			};
		}
		try {
			await durableContext.withExclusiveLease("efficiency-state-recovery", async () => {
				await durableContext.auxiliaryStore.write(
					EFFICIENCY_RUNTIME_AUXILIARY_RECORD,
					canonicalJsonBytes(recoveredState),
				);
			});
		} catch {
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_unavailable");
		}
		return recoveredState;
	};

	const readState = async (): Promise<PersistedEfficiencyRuntimeState> => {
		let bytes: Uint8Array | null;
		try {
			bytes = await durableContext.auxiliaryStore.read(EFFICIENCY_RUNTIME_AUXILIARY_RECORD);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				(error.message !== "Workflow auxiliary record belongs to a different generation." &&
					error.message !== "Workflow auxiliary record belongs to a different epoch.")
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_unavailable");
			const replay = await runtimeStore.replay({
				workflowId: input.approvedSchedule.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.approvedSchedule.epochRef.storeEpoch,
			});
			const recovered = recoverPersistedEfficiencyRuntimeStateFromReplay(
				replay,
				input.approvedSchedule.workflowId,
				durableContext.epochRef,
				input.approvedSchedule,
			);
			if (recovered === null)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_unavailable");
			return persistRecoveredState(recovered);
		}
		if (bytes === null) {
			const replay = await runtimeStore.replay({
				workflowId: input.approvedSchedule.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.approvedSchedule.epochRef.storeEpoch,
			});
			const recovered = recoverPersistedEfficiencyRuntimeStateFromReplay(
				replay,
				input.approvedSchedule.workflowId,
				durableContext.epochRef,
				input.approvedSchedule,
			);
			if (recovered !== null) return persistRecoveredState(recovered);
			return {
				version: 1,
				workflowId: input.approvedSchedule.workflowId,
				epochRef: input.approvedSchedule.epochRef,
				windows: {},
				consumedTokens: {},
			};
		}
		const persistedBytes: Uint8Array = bytes;
		const parsed = (() => {
			try {
				return parseCanonicalJsonBytes(persistedBytes);
			} catch {
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_invalid");
			}
		})();
		if (!isEfficiencyRecord(parsed) || !isEfficiencyEpochRef(parsed.epochRef))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_invalid");
		if (!isPersistedEfficiencyRuntimeState(parsed, input.approvedSchedule.workflowId, parsed.epochRef))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_invalid");
		return normalizePersistedEfficiencyRuntimeState(parsed, durableContext.epochRef, input.approvedSchedule);
	};

	const writeState = async (state: PersistedEfficiencyRuntimeState): Promise<void> => {
		try {
			await durableContext.auxiliaryStore.write(EFFICIENCY_RUNTIME_AUXILIARY_RECORD, canonicalJsonBytes(state));
		} catch {
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_unavailable");
		}
	};

	const durableWindowTransaction: WorkflowEfficiencyDurableWindowTransaction = {
		claimWindow: async (claim) =>
			durableContext.withExclusiveLease(`efficiency-window:${claim.workflowId}:${claim.dueWindowId}`, async () => {
				const state = await readState();
				const key = efficiencyWindowStoreKey(
					claim.workflowId,
					claim.epochRef,
					claim.dueWindowId,
					claim.scheduleDigest,
				);
				if (state.windows[key] !== undefined) return "already_claimed";
				await writeState({
					...state,
					windows: {
						...state.windows,
						[key]: {
							workflowId: claim.workflowId,
							epochRef: claim.epochRef,
							dueWindowId: claim.dueWindowId,
							scheduleDigest: claim.scheduleDigest,
							catchUp: claim.catchUp,
							expectedHead: null,
							hostMeasuredUsage: null,
							result: null,
							reallocationProposal: null,
							reallocationConsumption: null,
						},
					},
				});
				return "claimed";
			}),
		consumeToken: async (consume) =>
			durableContext.withExclusiveLease(`efficiency-token:${consume.workflowId}:${consume.tokenId}`, async () => {
				const state = await readState();
				const key = efficiencyTokenStoreKey(
					consume.workflowId,
					consume.epochRef,
					consume.tokenId,
					consume.dueWindowId,
					consume.scheduleDigest,
				);
				if (state.consumedTokens[key] === true) return "already_consumed";
				await writeState({ ...state, consumedTokens: { ...state.consumedTokens, [key]: true } });
				return "consumed";
			}),
	};

	const recordResult = async (
		append: WorkflowEfficiencyBoundaryAppendInput,
		payload: unknown,
	): Promise<WorkflowEfficiencyReallocationProposal | null> => {
		if (append.result === undefined || !isResult(append.result))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_result_invalid");
		if (!isEfficiencyJournalHead(append.expectedHead))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_head_required");
		let committedReplay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>;
		try {
			committedReplay = await runtimeStore.replay({
				workflowId: append.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: append.epochRef.storeEpoch,
			});
		} catch {
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_unavailable");
		}
		if (committedReplay.quarantined || !replayHeadPrecedes(append.expectedHead, committedReplay.head))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_boundary_not_committed");
		const scheduleDigest = append.schedule?.scheduleDigest ?? input.approvedSchedule.scheduleDigest;
		const key = efficiencyWindowStoreKey(append.workflowId, append.epochRef, append.dueWindowId, scheduleDigest);
		const state = await readState();
		const current = state.windows[key];
		const proposal = actionableReallocationFromBoundary(payload, append, append.result);
		const next: PersistedEfficiencyWindow = {
			workflowId: append.workflowId,
			epochRef: append.epochRef,
			dueWindowId: append.dueWindowId,
			scheduleDigest,
			catchUp: current?.catchUp ?? false,
			expectedHead: append.expectedHead,
			hostMeasuredUsage: append.hostMeasuredUsage ?? append.result.actualUsage,
			result: append.result,
			reallocationProposal: proposal ?? current?.reallocationProposal ?? null,
			reallocationConsumption: current?.reallocationConsumption ?? null,
		};
		await durableContext.withExclusiveLease(
			`efficiency-result:${append.workflowId}:${append.dueWindowId}`,
			async () => {
				const latest = await readState();
				await writeState({ ...latest, windows: { ...latest.windows, [key]: next } });
			},
		);
		return proposal;
	};

	const reviewStore: WorkflowEfficiencyReviewStore = {
		replay: async (replayInput) => {
			const replay = await runtimeStore.replay(replayInput);
			const state = await readState();
			const persistedEvents = Object.values(state.windows)
				.filter(
					(window) =>
						window.result !== null &&
						window.expectedHead !== null &&
						window.workflowId === replayInput.workflowId,
				)
				.map((window) => ({
					workflowId: window.workflowId,
					epochRef: window.epochRef,
					sequence: replay.head.sequence,
					eventDigest: replay.head.eventDigest,
					payload: {
						kind: "efficiency_red_team_completed",
						workflowId: window.workflowId,
						epochRef: window.epochRef,
						dueWindowId: window.dueWindowId,
						scheduleDigest: window.scheduleDigest,
						expectedHead: window.expectedHead,
						expectedHeadDigest: digestObject(window.expectedHead),
						result: window.result,
						hostMeasuredUsage: window.hostMeasuredUsage,
						actionableProposal: window.reallocationProposal,
					},
				}));
			return { ...replay, events: [...persistedEvents, ...replay.events] };
		},
	};

	const rootHostAppendBoundary = async (
		append: WorkflowEfficiencyBoundaryAppendInput,
	): Promise<WorkflowEfficiencyBoundaryAppendResult> => {
		const result = await input.rootHostAppendBoundary(append);
		if (append.eventKind === "efficiency_red_team_completed" && append.result !== undefined) {
			const proposal = await recordResult(append, result.payload);
			if (proposal !== null) {
				const consumption = await input.reallocationConsumer.consume(proposal);
				if (!isEfficiencyReallocationConsumerResult(consumption))
					throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_consumer_invalid");
				if (consumption.disposition === "rejected")
					throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_rejected");
				await durableContext.withExclusiveLease(
					`efficiency-reallocation:${append.workflowId}:${append.dueWindowId}`,
					async () => {
						const latest = await readState();
						const latestKey = efficiencyWindowStoreKey(
							append.workflowId,
							append.epochRef,
							append.dueWindowId,
							append.schedule?.scheduleDigest ?? input.approvedSchedule.scheduleDigest,
						);
						const latestWindow = latest.windows[latestKey];
						if (
							latestWindow === undefined ||
							latestWindow.reallocationProposal === null ||
							latestWindow.reallocationProposal.reportDigest !== proposal.reportDigest
						)
							throw new WorkflowEfficiencyReviewerError("workflow_efficiency_reallocation_stale");
						await writeState({
							...latest,
							windows: {
								...latest.windows,
								[latestKey]: { ...latestWindow, reallocationConsumption: consumption },
							},
						});
					},
				);
			}
		}
		return result;
	};

	return createWorkflowEfficiencyRedTeamRuntime({
		approvedSchedule: input.approvedSchedule,
		reviewer: input.reviewer,
		trustedNow: input.trustedNow,
		trustedMonotonicNow: input.trustedMonotonicNow,
		readActiveLeaseContext: input.readActiveLeaseContext,
		readCurrentJournalHead: async () => {
			const replay = await runtimeStore.replay({
				workflowId: input.approvedSchedule.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.approvedSchedule.epochRef.storeEpoch,
			});
			return replay.head;
		},
		reallocationConsumer: input.reallocationConsumer,
		reviewStore,
		durableWindowTransaction,
		rootHostAppendBoundary,
		snapshotResolver: input.snapshotResolver,
		scheduleManifestRef: input.scheduleManifestRef,
		scheduleArtifactResolver: input.scheduleArtifactResolver,
		snapshotArtifactResolver: input.snapshotArtifactResolver,
		reviewInvocationFactory: input.reviewInvocationFactory,
		readOnlyCapabilityProofResolver: input.readOnlyCapabilityProofResolver,
		readUsage: input.readUsage,
		overheadReserve: input.overheadReserve,
		readRevisionBoundaryContext: input.readRevisionBoundaryContext,
		revisionRegistry: input.revisionRegistry,
	});
}

/**
 * Create an event-driven, read-only efficiency watchdog over committed runtime events.
 *
 * Args:
 * dependencies: Approved schedule, read-only reviewer, and existing journal boundary.
 * Return: Runtime wake/replay facade.
 */
export function createWorkflowEfficiencyRedTeamRuntime(
	dependencies: WorkflowEfficiencyRedTeamRuntimeDependencies,
): WorkflowEfficiencyRedTeamRuntime {
	if (dependencies.readUsage === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_usage_reader_required");
	if (dependencies.trustedMonotonicNow === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_monotonic_clock_required");
	if (dependencies.readOnlyCapabilityProofResolver === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_capability_proof_resolver_required");
	if (dependencies.snapshotArtifactResolver === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_artifact_resolver_required");
	if (!isCanonicalArtifactRef(dependencies.scheduleManifestRef))
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_manifest_required");
	if (dependencies.reviewStore === undefined || dependencies.rootHostAppendBoundary === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_persistence_required");
	if (dependencies.durableWindowTransaction === undefined)
		throw new WorkflowEfficiencyReviewerError("workflow_efficiency_durable_window_transaction_required");
	const inFlight = new Map<string, Promise<WorkflowEfficiencyRedTeamResult | null>>();
	const completed = new Map<string, WorkflowEfficiencyRedTeamResult>();
	const consumedTokens = new Set<string>();
	const inFlightTokens = new Set<string>();
	const committedEventKeys = new Set<string>();
	const readCurrentJournalHead = async (): Promise<WorkflowJournalHead> => {
		if (dependencies.readCurrentJournalHead !== undefined) return dependencies.readCurrentJournalHead();
		if (dependencies.reviewStore === undefined)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_head_unavailable");
		const replay = await dependencies.reviewStore.replay({
			workflowId: dependencies.approvedSchedule.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: dependencies.approvedSchedule.epochRef.storeEpoch,
		});
		if (!isEfficiencyJournalHead(replay.head))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_head_unavailable");
		return replay.head;
	};
	const assertRevision = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	): Promise<void> => {
		if (dependencies.readRevisionBoundaryContext === undefined || dependencies.revisionRegistry === undefined)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_revision_boundary_missing");
		await assertRevisionBoundary(
			{
				readRevisionBoundaryContext: dependencies.readRevisionBoundaryContext,
				revisionRegistry: dependencies.revisionRegistry,
			},
			workflowId,
			epochRef,
			executionKey,
		);
	};

	const append = async (
		eventKind: string,
		workflowId: string,
		epochRef: WorkflowEpochRef,
		windowId: string,
		schedule: WorkflowEfficiencyReviewSchedule,
		result?: WorkflowEfficiencyRedTeamResult,
		hostMeasuredUsage?: WorkflowResourceVector,
	): Promise<void> => {
		if (dependencies.rootHostAppendBoundary === undefined) return;
		const replay =
			dependencies.reviewStore === undefined
				? null
				: await dependencies.reviewStore.replay({
						workflowId,
						fromSequence: 0,
						expectedStoreEpoch: epochRef.storeEpoch,
					});
		await dependencies.rootHostAppendBoundary({
			eventKind,
			workflowId,
			epochRef,
			dueWindowId: windowId,
			result,
			hostMeasuredUsage,
			schedule,
			idempotencyKey: `efficiency-red-team:${workflowId}:${windowId}:${schedule.scheduleDigest}:${eventKind}:${epochRef.storeEpoch}:${epochRef.coordinatorEpoch}`,
			expectedHead: replay?.head,
			expectedHeadDigest: replay === null ? undefined : digestObject(replay.head),
		});
	};

	const validateWake = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
		forceTrigger: boolean,
		catchUp: boolean,
	): Promise<{ windowId: string; replayed: WorkflowEfficiencyRedTeamResult | null; overlap: boolean } | null> => {
		if (!validSchedule(schedule)) throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_invalid");
		await verifyScheduleArtifacts(
			dependencies.approvedSchedule,
			dependencies.scheduleManifestRef,
			dependencies.scheduleArtifactResolver,
		);
		if (!approvedScheduleMatches(schedule, dependencies.approvedSchedule, workflowId, epochRef))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_approval_required");
		await verifyScheduleArtifacts(schedule, dependencies.scheduleManifestRef, dependencies.scheduleArtifactResolver);
		await assertRevision(workflowId, epochRef, null);
		const declaredReviewVector = (schedule.reviewResourceAdmission as { reservedVector?: WorkflowResourceVector })
			.reservedVector;
		if (
			declaredReviewVector !== undefined &&
			dependencies.overheadReserve !== undefined &&
			!fitsOverheadReserve(declaredReviewVector, dependencies.overheadReserve)
		)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_overhead_budget_exhausted");
		if (!Number.isFinite(Date.parse(dependencies.trustedNow())))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_trusted_clock_invalid");
		if (dependencies.readActiveLeaseContext !== undefined) {
			const context = await dependencies.readActiveLeaseContext();
			if (context.workflowId !== workflowId || !sameEpoch(context.epochRef, epochRef))
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_epoch_mismatch");
		}
		const windowId = dueWindowId(schedule);
		if (!forceTrigger && Date.parse(dependencies.trustedNow()) < Date.parse(schedule.nextDueAt)) return null;
		if (completed.has(windowId)) return { windowId, replayed: completed.get(windowId) ?? null, overlap: false };
		if (dependencies.reviewStore !== undefined) {
			const replay = await dependencies.reviewStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: epochRef.storeEpoch,
			});
			const replayed = findReplayResult(
				replay.events,
				windowId,
				workflowId,
				epochRef,
				schedule.scheduleDigest,
				replay.head,
			);
			if (replayed !== null) {
				completed.set(windowId, replayed);
				return { windowId, replayed, overlap: false };
			}
			if (
				catchUp &&
				replayHasCatchUpConsumed(replay.events, windowId, workflowId, epochRef, schedule.scheduleDigest)
			)
				return { windowId, replayed: null, overlap: true };
			if (!catchUp && replayHasStarted(replay.events, windowId, workflowId, epochRef, schedule.scheduleDigest))
				return { windowId, replayed: null, overlap: true };
		}
		return { windowId, replayed: null, overlap: false };
	};

	const assertToken = (token: WorkflowReadOnlyEfficiencyRedTeamToken): void => {
		if (!isValidReadOnlyToken(token))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_read_only_token_invalid");
		const now = dependencies.trustedMonotonicNow!();
		if (!Number.isFinite(now))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_monotonic_clock_invalid");
		if (now >= token.expiresAtMonotonicMs)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_token_expired");
	};

	const resolveReadOnlyCapabilityProof = async (
		invocation: WorkflowEfficiencyRedTeamInvocation,
	): Promise<WorkflowArtifactRef> => {
		const resolver = dependencies.readOnlyCapabilityProofResolver!;
		const read = resolver as (invocation?: WorkflowEfficiencyRedTeamInvocation) => Promise<WorkflowArtifactRef>;
		const proof = resolver.length === 0 ? await read() : await read(invocation);
		if (!isCanonicalArtifactRef(proof))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_capability_proof_invalid");
		const candidate = (invocation as Partial<WorkflowEfficiencyRedTeamInvocation>).readOnlyCapabilityProofRef;
		if (candidate !== undefined && (!isCanonicalArtifactRef(candidate) || candidate.digest !== proof.digest))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_capability_proof_mismatch");
		if (dependencies.snapshotArtifactResolver !== undefined) {
			let artifact: WorkflowArtifactReadResult;
			try {
				artifact = await dependencies.snapshotArtifactResolver.resolve(proof);
			} catch {
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_capability_proof_unavailable");
			}
			if (
				!artifact.exists ||
				!artifact.envelope.immutable ||
				digestObject(artifact.envelope.ref) !== digestObject(proof) ||
				artifact.verifiedDigest !== proof.digest ||
				artifact.verifiedSizeBytes !== proof.sizeBytes ||
				artifact.bytes.byteLength !== proof.sizeBytes ||
				sha256Hex(artifact.bytes) !== proof.digest
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_capability_proof_invalid");
		}
		return proof;
	};

	const withMeasuredUsage = (
		result: WorkflowEfficiencyRedTeamResult,
		usage: WorkflowResourceVector,
	): WorkflowEfficiencyRedTeamResult => {
		const updated = { ...result, actualUsage: usage };
		const { resultDigest: _resultDigest, ...preimage } = updated;
		return { ...updated, resultDigest: digestObject(preimage) };
	};

	const runWake = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
		forceTrigger: boolean,
		catchUp = false,
	): Promise<WorkflowEfficiencyRedTeamResult | null> => {
		const validated = await validateWake(workflowId, epochRef, schedule, forceTrigger, catchUp);
		if (validated === null) return null;
		if (validated.replayed !== null) return validated.replayed;
		if (validated.overlap) return null;
		const windowId = validated.windowId;
		const existing = inFlight.get(windowId);
		if (existing !== undefined) return existing;
		const claim = await dependencies.durableWindowTransaction!.claimWindow({
			workflowId,
			epochRef,
			dueWindowId: windowId,
			scheduleDigest: schedule.scheduleDigest,
			catchUp,
		});
		if (claim === "already_claimed") return inFlight.get(windowId) ?? completed.get(windowId) ?? null;
		if (claim !== "claimed") return null;
		const execution = (async (): Promise<WorkflowEfficiencyRedTeamResult | null> => {
			const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
				tokenId: `efficiency-token-${windowId}`,
				workflowId,
				epochRef,
				revisionTupleDigest: schedule.scheduleDigest,
				snapshotDigest: "",
				expiresAtMonotonicMs: dependencies.trustedMonotonicNow!() + schedule.maxReviewWallMilliseconds,
				remainingTokens: schedule.maxReviewTokens,
				remainingWallMilliseconds: schedule.maxReviewWallMilliseconds,
			};
			assertToken(token);
			if (catchUp) await append("efficiency_red_team_catch_up_consumed", workflowId, epochRef, windowId, schedule);
			await append("efficiency_red_team_started", workflowId, epochRef, windowId, schedule);
			let invocation: WorkflowEfficiencyRedTeamInvocation | null = null;
			try {
				const factoryInput = {
					...token,
					workflowId,
					epochRef,
					dueWindowId: windowId,
					schedule,
					token,
				};
				invocation = await dependencies.reviewInvocationFactory(factoryInput);
				await assertRevision(workflowId, epochRef, invocation.executionKey);
				await resolveReadOnlyCapabilityProof(invocation);
				const snapshot = await dependencies.snapshotResolver(invocation);
				if (snapshot.scheduleId !== schedule.scheduleId)
					throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_revoked");
				const resolvedToken: WorkflowReadOnlyEfficiencyRedTeamToken = {
					...token,
					snapshotDigest: snapshot.snapshotDigest,
				};
				validateSnapshot(invocation, resolvedToken, snapshot);
				await verifySnapshotArtifacts(snapshot, dependencies.snapshotArtifactResolver);
				const result = await dependencies.reviewer.review(invocation, resolvedToken);
				if (!isResult(result)) throw new WorkflowEfficiencyReviewerError("workflow_efficiency_result_invalid");
				const measuredUsage = await readUsage(dependencies.readUsage!, invocation);
				assertToken(resolvedToken);
				if (!fitsReviewBudget(measuredUsage, schedule, dependencies.overheadReserve)) {
					const boundedFailure = failureResult(invocation, "timed_out", dependencies.trustedNow(), measuredUsage);
					await append(
						"efficiency_red_team_completed",
						workflowId,
						epochRef,
						windowId,
						schedule,
						boundedFailure,
						measuredUsage,
					);
					completed.set(windowId, boundedFailure);
					return boundedFailure;
				}
				const measuredResult = withMeasuredUsage(result, measuredUsage);
				await append(
					"efficiency_red_team_completed",
					workflowId,
					epochRef,
					windowId,
					schedule,
					measuredResult,
					measuredUsage,
				);
				completed.set(windowId, measuredResult);
				return measuredResult;
			} catch (error) {
				if (
					error instanceof WorkflowEfficiencyReviewerError &&
					error.code.startsWith("workflow_efficiency_reallocation_")
				)
					throw error;
				let measuredUsage = zeroVector();
				if (invocation !== null) {
					try {
						measuredUsage = await readUsage(dependencies.readUsage!, invocation);
					} catch {
						// A failed host usage read is represented by the bounded failure itself.
					}
				}
				const result =
					invocation === null
						? failureResultForWindow(windowId, "failed", dependencies.trustedNow(), measuredUsage)
						: failureResult(invocation, "failed", dependencies.trustedNow(), measuredUsage);
				await append(
					"efficiency_red_team_completed",
					workflowId,
					epochRef,
					windowId,
					schedule,
					result,
					result.actualUsage,
				);
				completed.set(windowId, result);
				return result;
			}
		})();
		inFlight.set(windowId, execution);
		try {
			return await execution;
		} finally {
			inFlight.delete(windowId);
		}
	};

	const wake = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
	): Promise<WorkflowEfficiencyRedTeamResult | null> => runWake(workflowId, epochRef, schedule, false);

	const wakeInvocation = async (
		inputOrInvocation: WorkflowEfficiencyRedTeamWakeInput | WorkflowEfficiencyRedTeamInvocation,
		token?: WorkflowReadOnlyEfficiencyRedTeamToken,
	): Promise<WorkflowEfficiencyRedTeamResult | null> => {
		const input: WorkflowEfficiencyRedTeamWakeInput =
			token === undefined
				? (inputOrInvocation as WorkflowEfficiencyRedTeamWakeInput)
				: {
						invocation: inputOrInvocation as WorkflowEfficiencyRedTeamInvocation,
						token,
						schedule: dependencies.approvedSchedule,
					};
		const tokenKey = `${input.token.workflowId}:${input.token.tokenId}:${dueWindowId(input.schedule)}`;
		if (consumedTokens.has(tokenKey)) throw new WorkflowEfficiencyReviewerError("workflow_efficiency_token_replayed");
		if (!validSchedule(input.schedule))
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_schedule_invalid");
		assertToken(input.token);
		if (input.token.revisionTupleDigest !== input.schedule.scheduleDigest)
			throw new WorkflowEfficiencyReviewerError("workflow_efficiency_revision_boundary_mismatch");
		if (inFlightTokens.has(tokenKey)) throw new WorkflowEfficiencyReviewerError("workflow_efficiency_token_replayed");
		inFlightTokens.add(tokenKey);
		try {
			const validated = await validateWake(
				input.token.workflowId,
				input.token.epochRef,
				input.schedule,
				true,
				false,
			);
			if (validated === null) return null;
			const tokenDisposition = await dependencies.durableWindowTransaction!.consumeToken({
				workflowId: input.token.workflowId,
				epochRef: input.token.epochRef,
				tokenId: input.token.tokenId,
				dueWindowId: validated.windowId,
				scheduleDigest: input.schedule.scheduleDigest,
			});
			if (tokenDisposition !== "consumed")
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_token_replayed");
			consumedTokens.add(tokenKey);
			if (validated.replayed !== null) {
				return validated.replayed;
			}
			if (validated.overlap) {
				return null;
			}
			if (!sameEpoch(input.invocation.epochRef, input.token.epochRef))
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_epoch_mismatch");
			await append(
				"efficiency_red_team_started",
				input.token.workflowId,
				input.token.epochRef,
				validated.windowId,
				input.schedule,
			);
			await assertRevision(input.token.workflowId, input.token.epochRef, input.invocation.executionKey);
			await resolveReadOnlyCapabilityProof(input.invocation);
			const snapshot = await dependencies.snapshotResolver(input.invocation);
			if (snapshot.scheduleId !== input.schedule.scheduleId)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_revoked");
			validateSnapshot(input.invocation, input.token, snapshot);
			await verifySnapshotArtifacts(snapshot, dependencies.snapshotArtifactResolver);
			if (snapshot.snapshotDigest !== input.token.snapshotDigest)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_snapshot_stale");
			const result = await dependencies.reviewer.review(input.invocation, input.token);
			if (!isResult(result)) throw new WorkflowEfficiencyReviewerError("workflow_efficiency_result_invalid");
			const measuredUsage = await readUsage(dependencies.readUsage!, input.invocation);
			assertToken(input.token);
			if (!fitsReviewBudget(measuredUsage, input.schedule, dependencies.overheadReserve)) {
				const boundedFailure = failureResult(
					input.invocation,
					"timed_out",
					dependencies.trustedNow(),
					measuredUsage,
				);
				await append(
					"efficiency_red_team_completed",
					input.token.workflowId,
					input.token.epochRef,
					validated.windowId,
					input.schedule,
					boundedFailure,
					measuredUsage,
				);
				completed.set(validated.windowId, boundedFailure);
				return boundedFailure;
			}
			const measuredResult = withMeasuredUsage(result, measuredUsage);
			await append(
				"efficiency_red_team_completed",
				input.token.workflowId,
				input.token.epochRef,
				validated.windowId,
				input.schedule,
				measuredResult,
				measuredUsage,
			);
			completed.set(validated.windowId, measuredResult);
			return measuredResult;
		} finally {
			inFlightTokens.delete(tokenKey);
		}
	};

	const crashAfterWakeInFreshProcess = async (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		schedule: WorkflowEfficiencyReviewSchedule,
	): Promise<WorkflowEfficiencyRedTeamResult | null> => runWake(workflowId, epochRef, schedule, false, true);

	return {
		wake,
		wakeInvocation,
		onCommittedEvent: async (event) => {
			if (event.committed === false) return null;
			if (
				typeof event.workflowId !== "string" ||
				event.workflowId.length === 0 ||
				!isEfficiencyEpochRef(event.epochRef) ||
				!Number.isSafeInteger(event.eventSequence) ||
				event.eventSequence < 0 ||
				typeof event.eventDigest !== "string" ||
				event.eventDigest.length === 0
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_identity_required");
			if (
				event.workflowId !== dependencies.approvedSchedule.workflowId ||
				!sameEpoch(event.epochRef, dependencies.approvedSchedule.epochRef)
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_identity_mismatch");
			const trigger = TRIGGER_KINDS[event.kind];
			if (trigger === undefined || !dependencies.approvedSchedule.triggerSet.includes(trigger)) return null;
			const eventKey = `${event.workflowId}:${event.epochRef.storeEpoch}:${event.epochRef.coordinatorEpoch}:${event.eventSequence}:${event.eventDigest}`;
			if (committedEventKeys.has(eventKey))
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_replayed");
			let currentHead: WorkflowJournalHead;
			try {
				currentHead = await readCurrentJournalHead();
			} catch (error) {
				if (error instanceof WorkflowEfficiencyReviewerError) throw error;
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_head_unavailable");
			}
			if (
				currentHead.workflowId !== event.workflowId ||
				!sameEpoch(currentHead.epochRef, event.epochRef) ||
				currentHead.sequence !== event.eventSequence ||
				currentHead.eventDigest !== event.eventDigest
			)
				throw new WorkflowEfficiencyReviewerError("workflow_efficiency_committed_event_head_mismatch");
			committedEventKeys.add(eventKey);
			return runWake(event.workflowId, event.epochRef, dependencies.approvedSchedule, true);
		},
		recover: async (workflowId, epochRef, schedule) => runWake(workflowId, epochRef, schedule, false, true),
		crashAfterWakeInFreshProcess,
	};
}

export type { WorkflowEfficiencyReviewSchedule };
