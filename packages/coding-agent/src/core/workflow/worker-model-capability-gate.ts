import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	type WorkflowEpochRef,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { assertWorkflowRuntimeVersion } from "./runtime-store-adapter.js";

/** Exact host capability required to admit a worker model. */
export const WORKER_MODEL_CAPABILITY = "workflow_worker_model_dispatch" as const;

/** Exact worker selector admitted by the workflow host. */
export const WORKER_MODEL_PROVIDER = "openai-codex" as const;
export const WORKER_MODEL_ID = "gpt-5.6-luna" as const;
export const WORKER_MODEL_SELECTOR = `${WORKER_MODEL_PROVIDER}/${WORKER_MODEL_ID}` as const;

/**
 * Every model the host will admit as a worker.
 *
 * Compute tiering needs more than one selector, but the set stays closed: an arbitrary selector
 * reaching the gate is denied rather than admitted, so no caller can substitute a model the host
 * never vetted. WORKER_MODEL_ID remains the default when a task declares no compute class.
 */
export const WORKER_MODEL_IDS = Object.freeze(["gpt-5.6-luna", "gpt-5.6-sol"] as const);

/**
 * Reasoning level each admitted model runs at.
 *
 * One table rather than one constant, because the tiers are chosen for different reasons: the cheap
 * tier does the bulk of ordinary work and runs at max, while the deep tier is picked for tasks where
 * the model itself is the upgrade and pays for that in latency rather than in effort. The gate
 * rejects a policy whose reasoning disagrees with this table, so a caller cannot run an admitted
 * model at a level the host never vetted.
 */
export const WORKER_MODEL_REASONING_BY_ID = Object.freeze({
	"gpt-5.6-luna": "max",
	// A model's thinkingLevelMap needs explicit entries only for xhigh and max; every other level
	// passes through, so sol supports off/low/medium/high/xhigh/max and "high" is not clamped.
	// workflow-worker-reasoning-tier asserts that against the catalog, because reading the map alone
	// suggests the opposite.
	"gpt-5.6-sol": "high",
} as const satisfies Record<(typeof WORKER_MODEL_IDS)[number], string>);

/** Reasoning level of the default worker model. */
export const WORKER_MODEL_REASONING = WORKER_MODEL_REASONING_BY_ID[WORKER_MODEL_ID];

/**
 * Reasoning level for an admitted worker model id.
 *
 * Args:
 * modelId: Model id from a launch request.
 * Return: The declared level, or undefined when the id is not admitted.
 */
export function workerModelReasoningFor(modelId: string): string | undefined {
	return (WORKER_MODEL_REASONING_BY_ID as Readonly<Record<string, string>>)[modelId];
}

/** Authenticated auxiliary record used by the gate; it is not a session ledger. */
export const WORKER_MODEL_CAPABILITY_AUXILIARY_NAME = "worker-model-capability-gate.json" as const;

const DURABLE_SCHEMA_VERSION = 1 as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONTRACT_CHANGE_PREFIX = "CONTRACT_CHANGE:";
const WORKER_MODEL_LEASE_BOUNDARY = "worker_model_capability_gate";
const WORKER_MODEL_RETRY_TTL_MILLISECONDS = 30_000;

/** Caller-supplied policy input. The optional model lets validation report an omitted selector explicitly. */
export interface WorkerModelPolicyInput {
	readonly provider: string;
	readonly model?: string;
	readonly reasoning: string;
	readonly allowFallback?: boolean;
	readonly policyRevision: string;
}

/** Canonical worker policy bound into every preflight, admission, and handshake. */
export interface WorkerModelPolicy {
	readonly provider: string;
	readonly model: string;
	readonly reasoning: string;
	readonly allowFallback: false;
	readonly policyRevision: string;
}

export interface WorkerModelCapabilityPreflightInput {
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
}

export interface WorkerModelCapabilityInspectionInput extends WorkerModelCapabilityPreflightInput {
	readonly workflowId: string;
	readonly policy: WorkerModelPolicy;
}

/** Host-only availability facts. Provider bodies, headers, and credentials never cross this boundary. */
export interface WorkerModelCapabilityInspection {
	readonly authenticated: boolean;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly safeReason: string;
	readonly receipt: WorkflowVerifiedHostReceipt | null;
	readonly desiredWorkers?: number;
	readonly activeWorkers?: number;
	readonly idleCapacity?: number;
	readonly idleReason?: string | null;
	readonly retryAt?: string | null;
}

/** Typed adapter to the sealed host receipt authority. No existing capability is substituted. */
export interface WorkerModelCapabilityAuthorizationInput extends WorkerModelCapabilityInspectionInput {
	readonly capability: typeof WORKER_MODEL_CAPABILITY;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
}

export interface WorkerModelCapabilityAuthorization {
	readonly authenticatedPrincipal: string;
	readonly capability: typeof WORKER_MODEL_CAPABILITY;
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	/** Task-specific dispatch receipt. It is distinct from the read-only preflight receipt. */
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly authorizationDigest: string;
}

export interface WorkerModelCapabilityHost {
	inspect(input: WorkerModelCapabilityInspectionInput): Promise<WorkerModelCapabilityInspection>;
	authorize?(input: WorkerModelCapabilityAuthorizationInput): Promise<WorkerModelCapabilityAuthorization>;
}

/** Launch context bound by the scheduler before a worker child is created. */
export interface WorkerModelCapabilityLaunchInput {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly prompt: string;
	readonly sessionName: string;
	readonly selector: string;
	readonly provider: string;
	readonly model: string;
	readonly reasoning: string;
	/** Fallback stays disabled so a worker can never silently run on a model the host did not admit. */
	readonly allowFallback: false;
}

/** Host-owned admission and handshake returned by the sealed worker authority. */
export interface WorkerModelCapabilityLaunchAdmission {
	readonly intent: WorkerModelAdmissionIntent;
	handshake(actual: WorkerModelChildModelBinding): Promise<WorkerModelCapabilityHandshakeResult>;
}

export type WorkerModelCapabilityLaunchAuthorizer = (
	input: WorkerModelCapabilityLaunchInput,
) => Promise<WorkerModelCapabilityLaunchAdmission>;

/** Existing session projection authority used for public blocker metadata. */
export interface WorkerModelCapabilityProjection {
	append(blocker: WorkerModelCapabilityBlocker): Promise<void> | void;
	clear(blocker: WorkerModelCapabilityBlocker): Promise<void> | void;
}

export type WorkerModelCapabilityPreflightStatus = "available" | "blocked" | "contract_change";

export interface WorkerModelCapabilityPreflight {
	readonly status: WorkerModelCapabilityPreflightStatus;
	readonly workflowId: string;
	readonly policy: WorkerModelPolicy;
	readonly authenticated: boolean;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly safeReason: string;
	readonly receipt: WorkflowVerifiedHostReceipt | null;
	readonly receiptDigest: string | null;
	readonly desiredWorkers: number;
	readonly activeWorkers: number;
	readonly idleCapacity: number;
	readonly idleReason: string | null;
	readonly retryAt: string | null;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly preflightDigest: string;
}

export interface WorkerModelQueuedWorkInput {
	readonly taskId: string;
	readonly goalId: string;
	readonly enqueuedAt: string;
}

export interface WorkerModelQueuedWork extends WorkerModelQueuedWorkInput {
	readonly requestedPolicy: WorkerModelPolicy;
	readonly queueDigest: string;
}

export interface WorkerModelCapabilityBlockerSummary {
	readonly kind: "blocked_model_capability";
	readonly taskId: string;
	readonly goalId: string;
	readonly text: string;
}

export interface WorkerModelCapabilityBlockerProjection {
	readonly kind: "blocked_model_capability";
	readonly workflowId: string;
	readonly taskId: string;
	readonly goalId: string;
	readonly queueState: "queued";
	readonly blockerDigest: string;
}

export interface WorkerModelCapabilityBlocker {
	readonly kind: "blocked_model_capability";
	readonly workflowId: string;
	readonly taskId: string;
	readonly goalId: string;
	readonly requestedPolicy: WorkerModelPolicy;
	readonly safeReason: string;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly preflightDigest: string;
	readonly receiptDigest: string | null;
	readonly retryEligible: boolean;
	readonly retryAt: string | null;
	readonly desiredWorkers: number;
	readonly activeWorkers: number;
	readonly idleCapacity: number;
	readonly idleReason: string | null;
	readonly queuedWorkDigest: string;
	readonly summary: WorkerModelCapabilityBlockerSummary;
	readonly projection: WorkerModelCapabilityBlockerProjection;
	readonly blockerDigest: string;
}

export interface WorkerModelCapabilityRetryLease {
	readonly leaseId: string;
	readonly blockerId: string;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly revisionDigest: string;
	readonly leasedAt: string;
}

export interface WorkerModelChildModelBinding {
	readonly provider: string;
	readonly model: string;
	readonly reasoning: string;
	readonly allowFallback: boolean;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly receiptDigest: string;
	readonly artifactDigests?: readonly string[];
}

export interface WorkerModelAdmissionIntent {
	readonly kind: "worker_model_admission_intent";
	readonly workflowId: string;
	readonly taskId: string;
	readonly goalId: string;
	/** Scheduler attempt binding; omitted only for standalone gate callers without an attempt. */
	readonly attemptId?: string;
	readonly executionKey?: string;
	readonly policy: WorkerModelPolicy;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly policyRevision: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly receiptDigest: string;
	readonly bindingDigest: string;
	readonly authorizationDigest: string;
	readonly childModel: WorkerModelChildModelBinding;
	readonly admissionDigest: string;
}

export interface WorkerModelCapabilityDispatchInput extends WorkerModelCapabilityPreflightInput {
	readonly taskId: string;
	readonly goalId: string;
	readonly enqueuedAt: string;
	/** Scheduler attempt binding carried into the persisted receipt and admission intent. */
	readonly attemptId?: string;
	readonly executionKey?: string;
	readonly preflight: WorkerModelCapabilityPreflight;
}

export type WorkerModelCapabilityDispatchResult =
	| {
			readonly status: "admitted";
			readonly intent: WorkerModelAdmissionIntent;
	  }
	| {
			readonly status: "blocked";
			readonly queuedWork: WorkerModelQueuedWork;
			readonly blocker: WorkerModelCapabilityBlocker;
			readonly contractChange: string | null;
	  };

export interface WorkerModelCapabilityRetryInput {
	readonly blockerId: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
	readonly preflight: WorkerModelCapabilityPreflight;
}

export type WorkerModelCapabilityRetryResult =
	| { readonly status: "retry_leased"; readonly lease: WorkerModelCapabilityRetryLease }
	| { readonly status: "already_leased"; readonly lease: WorkerModelCapabilityRetryLease }
	| { readonly status: "unchanged"; readonly blocker: WorkerModelCapabilityBlocker }
	| { readonly status: "blocked"; readonly blocker: WorkerModelCapabilityBlocker };

export interface WorkerModelCapabilityHandshakeInput {
	readonly admission: WorkerModelAdmissionIntent;
	readonly actual: WorkerModelChildModelBinding;
}

export interface WorkerModelCapabilityQuarantineIntent {
	readonly kind: "worker_model_capability_quarantine";
	readonly workflowId: string;
	readonly taskId: string;
	readonly goalId: string;
	readonly admissionDigest: string;
	readonly reason:
		| "forged_admission"
		| "model_selector_mismatch"
		| "fallback_forbidden"
		| "revision_mismatch"
		| "receipt_mismatch";
	readonly expected: WorkerModelChildModelBinding;
	readonly actual: WorkerModelChildModelBinding;
	readonly inadmissibleArtifactDigests: readonly string[];
	readonly intentDigest: string;
}

export type WorkerModelCapabilityHandshakeResult =
	| { readonly status: "accepted"; readonly admissionDigest: string }
	| {
			readonly status: "terminate_quarantine";
			readonly quarantine: WorkerModelCapabilityQuarantineIntent;
	  };

export interface WorkerModelCapabilityDurableSnapshot {
	readonly workflowId: string;
	readonly queuedWork: readonly WorkerModelQueuedWork[];
	readonly blockers: readonly WorkerModelCapabilityBlocker[];
	readonly blocker: WorkerModelCapabilityBlocker | null;
	readonly retryLeases: readonly WorkerModelCapabilityRetryLease[];
	readonly admissions: readonly WorkerModelAdmissionIntent[];
	readonly quarantines: readonly WorkerModelCapabilityQuarantineIntent[];
	readonly stateDigest: string;
}

export interface WorkerModelCapabilityGateOptions {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly runtimeVersion: string;
	readonly policy: WorkerModelPolicyInput;
	readonly host: WorkerModelCapabilityHost;
	readonly projection?: WorkerModelCapabilityProjection;
	/** Host process authority that terminates and fences a quarantined child. */
	readonly quarantine?: (intent: WorkerModelCapabilityQuarantineIntent) => Promise<void> | void;
	readonly now?: () => string;
}

export interface WorkerModelCapabilityGate {
	preflight(input: WorkerModelCapabilityPreflightInput): Promise<WorkerModelCapabilityPreflight>;
	dispatch(input: WorkerModelCapabilityDispatchInput): Promise<WorkerModelCapabilityDispatchResult>;
	retry(input: WorkerModelCapabilityRetryInput): Promise<WorkerModelCapabilityRetryResult>;
	handshake(input: WorkerModelCapabilityHandshakeInput): Promise<WorkerModelCapabilityHandshakeResult>;
	readState(): Promise<WorkerModelCapabilityDurableSnapshot>;
}

interface WorkerModelCapabilityDurableState {
	readonly schemaVersion: typeof DURABLE_SCHEMA_VERSION;
	readonly workflowId: string;
	readonly queuedWork: readonly WorkerModelQueuedWork[];
	readonly blockers: readonly WorkerModelCapabilityBlocker[];
	readonly retryLeases: readonly WorkerModelCapabilityRetryLease[];
	readonly admissions: readonly WorkerModelAdmissionIntent[];
	readonly quarantines: readonly WorkerModelCapabilityQuarantineIntent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, label: string, maxLength = 512): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		/[\u0000-\u001f\u007f]/u.test(value)
	)
		throw new Error(`${label}_invalid`);
	return value;
}

function sanitizeSafeReason(value: unknown, label: string): string {
	const reason = safeString(value, label, 512);
	return reason
		.replace(
			/((?:api[ _-]?key|authorization|bearer|cookie|credential|password|secret|token))\s*[:=]\s*\S+/giu,
			"$1=[redacted]",
		)
		.replace(/\b(?:sk|sess|key|tok)-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]");
}

function safeDigest(value: unknown, label: string): string {
	const result = safeString(value, label, 64);
	if (!DIGEST_PATTERN.test(result)) throw new Error(`${label}_invalid`);
	return result;
}

function safeNonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}_invalid`);
	return value as number;
}

function safeRetryAt(value: unknown, label: string): string | null {
	if (value === null) return null;
	const retryAt = safeString(value, label, 128);
	if (!Number.isFinite(Date.parse(retryAt))) throw new Error(`${label}_invalid`);
	return retryAt;
}

function assertEpochRef(value: unknown, label: string): asserts value is WorkflowEpochRef {
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.storeEpoch) ||
		(value.storeEpoch as number) < 1 ||
		!Number.isSafeInteger(value.coordinatorEpoch) ||
		(value.coordinatorEpoch as number) < 1
	)
		throw new Error(`${label}_invalid`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertRevision(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label}_invalid`);
	return value as number;
}

function normalizePolicy(input: WorkerModelPolicyInput): WorkerModelPolicy {
	const provider = safeString(input.provider, "worker_model_policy_provider", 256);
	if (input.model === undefined) throw new Error("worker_model_policy_model_required");
	const model = safeString(input.model, "worker_model_policy_model", 512);
	const admittedReasoning = workerModelReasoningFor(model);
	if (admittedReasoning === undefined) throw new Error("worker_model_policy_selector_denied");
	const reasoning = safeString(input.reasoning, "worker_model_policy_reasoning", 128);
	if (reasoning !== admittedReasoning) throw new Error("worker_model_policy_reasoning_denied");
	if (input.allowFallback !== false) throw new Error("worker_model_policy_fallback_forbidden");
	const policyRevision = safeString(input.policyRevision, "worker_model_policy_revision", 256);
	return { provider, model, reasoning, allowFallback: false, policyRevision };
}

function assertWorkflowId(value: unknown, label: string): string {
	return safeString(value, label, 256);
}

function assertReceiptEnvelope(value: unknown): asserts value is WorkflowVerifiedHostReceipt {
	if (!isRecord(value)) throw new Error("worker_model_capability_receipt_required");
	if (value.receiptKind !== "capability") throw new Error("worker_model_capability_receipt_kind_invalid");
	if (!isRecord(value.capabilityBinding) || value.capabilityBinding.capability !== WORKER_MODEL_CAPABILITY)
		throw new Error(`${CONTRACT_CHANGE_PREFIX} sealed receipt capability union needs ${WORKER_MODEL_CAPABILITY}.`);
	safeString(value.receiptId, "worker_model_capability_receipt_id", 256);
	safeString(value.signature, "worker_model_capability_receipt_signature", 16_384);
	safeString(value.verificationDigest, "worker_model_capability_receipt_digest", 64);
}

function safeContractReason(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.startsWith(CONTRACT_CHANGE_PREFIX)) {
		return error.message.slice(0, 512);
	}
	return fallback;
}

function isContractChange(reason: string): boolean {
	return reason.startsWith(CONTRACT_CHANGE_PREFIX);
}

function retryEligibleForReason(reason: string): boolean {
	return !isContractChange(reason) && reason !== "policy_denied" && reason !== "worker_model_policy_revision_mismatch";
}

function cloneValue<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch (error) {
		throw new Error("CONTRACT_CHANGE: worker model gate values must be structured-cloneable.", { cause: error });
	}
}

function emptyDurableState(workflowId: string): WorkerModelCapabilityDurableState {
	return {
		schemaVersion: DURABLE_SCHEMA_VERSION,
		workflowId,
		queuedWork: [],
		blockers: [],
		retryLeases: [],
		admissions: [],
		quarantines: [],
	};
}

function queueDigestInput(value: WorkerModelQueuedWorkInput, policy: WorkerModelPolicy): object {
	return { taskId: value.taskId, goalId: value.goalId, enqueuedAt: value.enqueuedAt, requestedPolicy: policy };
}

function makeQueuedWork(input: WorkerModelQueuedWorkInput, policy: WorkerModelPolicy): WorkerModelQueuedWork {
	const taskId = assertWorkflowId(input.taskId, "worker_model_task_id");
	const goalId = assertWorkflowId(input.goalId, "worker_model_goal_id");
	const enqueuedAt = safeString(input.enqueuedAt, "worker_model_enqueued_at", 128);
	const base = { taskId, goalId, enqueuedAt, requestedPolicy: policy };
	return { ...base, queueDigest: digestObject(queueDigestInput({ taskId, goalId, enqueuedAt }, policy)) };
}

function preflightDigestInput(preflight: Omit<WorkerModelCapabilityPreflight, "preflightDigest">): object {
	return {
		workflowId: preflight.workflowId,
		policy: preflight.policy,
		status: preflight.status,
		authenticated: preflight.authenticated,
		authRevision: preflight.authRevision,
		capabilityRevision: preflight.capabilityRevision,
		policyRevision: preflight.policyRevision,
		safeReason: preflight.safeReason,
		receiptDigest: preflight.receiptDigest,
		desiredWorkers: preflight.desiredWorkers,
		activeWorkers: preflight.activeWorkers,
		idleCapacity: preflight.idleCapacity,
		idleReason: preflight.idleReason,
		retryAt: preflight.retryAt,
		stateDigest: preflight.stateDigest,
		revision: preflight.revision,
		epochRef: preflight.epochRef,
	};
}

function makePreflight(input: Omit<WorkerModelCapabilityPreflight, "preflightDigest">): WorkerModelCapabilityPreflight {
	return { ...input, preflightDigest: digestObject(preflightDigestInput(input)) };
}

function blockerDigestInput(blocker: Omit<WorkerModelCapabilityBlocker, "blockerDigest">): object {
	return {
		...blocker,
		projection: { ...blocker.projection, blockerDigest: "" },
	};
}

function makeBlocker(input: Omit<WorkerModelCapabilityBlocker, "blockerDigest">): WorkerModelCapabilityBlocker {
	return { ...input, blockerDigest: digestObject(blockerDigestInput(input)) };
}

function retryLeaseDigestInput(
	lease: Pick<WorkerModelCapabilityRetryLease, "blockerId" | "authRevision" | "capabilityRevision">,
): object {
	return {
		blockerId: lease.blockerId,
		authRevision: lease.authRevision,
		capabilityRevision: lease.capabilityRevision,
	};
}

function makeRetryLease(
	input: Omit<WorkerModelCapabilityRetryLease, "revisionDigest">,
): WorkerModelCapabilityRetryLease {
	return { ...input, revisionDigest: digestObject(retryLeaseDigestInput(input)) };
}

function admissionDigestInput(intent: Omit<WorkerModelAdmissionIntent, "admissionDigest">): object {
	return intent;
}

function makeAdmissionIntent(input: Omit<WorkerModelAdmissionIntent, "admissionDigest">): WorkerModelAdmissionIntent {
	return { ...input, admissionDigest: digestObject(admissionDigestInput(input)) };
}

function quarantineDigestInput(intent: Omit<WorkerModelCapabilityQuarantineIntent, "intentDigest">): object {
	return intent;
}

function makeQuarantineIntent(
	input: Omit<WorkerModelCapabilityQuarantineIntent, "intentDigest">,
): WorkerModelCapabilityQuarantineIntent {
	return { ...input, intentDigest: digestObject(quarantineDigestInput(input)) };
}

function childBindingFromAdmission(
	policy: WorkerModelPolicy,
	authRevision: string,
	capabilityRevision: string,
	policyRevision: string,
	receiptDigest: string,
): WorkerModelChildModelBinding {
	return {
		provider: policy.provider,
		model: policy.model,
		reasoning: policy.reasoning,
		allowFallback: false,
		authRevision,
		capabilityRevision,
		policyRevision,
		receiptDigest,
	};
}

function bindingMismatchReason(
	expected: WorkerModelChildModelBinding,
	actual: WorkerModelChildModelBinding,
): WorkerModelCapabilityQuarantineIntent["reason"] | null {
	if (actual.allowFallback !== false) return "fallback_forbidden";
	if (
		actual.provider !== expected.provider ||
		actual.model !== expected.model ||
		actual.reasoning !== expected.reasoning
	)
		return "model_selector_mismatch";
	if (
		actual.authRevision !== expected.authRevision ||
		actual.capabilityRevision !== expected.capabilityRevision ||
		actual.policyRevision !== expected.policyRevision
	)
		return "revision_mismatch";
	if (actual.receiptDigest !== expected.receiptDigest) return "receipt_mismatch";
	return null;
}

function normalizeChildBinding(value: WorkerModelChildModelBinding | null | undefined): WorkerModelChildModelBinding {
	const candidate: Record<string, unknown> = isRecord(value) ? value : {};
	const normalize = (candidate: unknown, label: string, maxLength: number): string => {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maxLength)
			return `<invalid:${label}>`;
		return /[\u0000-\u001f\u007f]/u.test(candidate) ? `<invalid:${label}>` : candidate;
	};
	const artifacts = Array.isArray(candidate.artifactDigests)
		? candidate.artifactDigests.filter(
				(digest): digest is string => typeof digest === "string" && DIGEST_PATTERN.test(digest),
			)
		: [];
	return {
		provider: normalize(candidate.provider, "provider", 256),
		model: normalize(candidate.model, "model", 512),
		reasoning: normalize(candidate.reasoning, "reasoning", 128),
		allowFallback: candidate.allowFallback !== false,
		authRevision: normalize(candidate.authRevision, "authRevision", 256),
		capabilityRevision: normalize(candidate.capabilityRevision, "capabilityRevision", 256),
		policyRevision: normalize(candidate.policyRevision, "policyRevision", 256),
		receiptDigest: normalize(candidate.receiptDigest, "receiptDigest", 64),
		...(artifacts.length === 0 ? {} : { artifactDigests: artifacts }),
	};
}

function assertQueueWork(value: unknown): asserts value is WorkerModelQueuedWork {
	if (!isRecord(value)) throw new Error("worker_model_queue_record_invalid");
	const policy = value.requestedPolicy;
	if (!isRecord(policy)) throw new Error("worker_model_queue_policy_invalid");
	normalizePolicy({
		provider: policy.provider as string,
		model: policy.model as string,
		reasoning: policy.reasoning as string,
		allowFallback: policy.allowFallback as boolean,
		policyRevision: policy.policyRevision as string,
	});
	const taskId = assertWorkflowId(value.taskId, "worker_model_queue_task_id");
	const goalId = assertWorkflowId(value.goalId, "worker_model_queue_goal_id");
	const enqueuedAt = safeString(value.enqueuedAt, "worker_model_queue_enqueued_at", 128);
	const queueDigest = safeDigest(value.queueDigest, "worker_model_queue_digest");
	if (
		queueDigest !==
		digestObject(queueDigestInput({ taskId, goalId, enqueuedAt }, policy as unknown as WorkerModelPolicy))
	)
		throw new Error("worker_model_queue_digest_invalid");
}

function assertBlocker(value: unknown): asserts value is WorkerModelCapabilityBlocker {
	if (!isRecord(value) || value.kind !== "blocked_model_capability") throw new Error("worker_model_blocker_invalid");
	assertWorkflowId(value.workflowId, "worker_model_blocker_workflow_id");
	assertWorkflowId(value.taskId, "worker_model_blocker_task_id");
	assertWorkflowId(value.goalId, "worker_model_blocker_goal_id");
	if (!isRecord(value.requestedPolicy)) throw new Error("worker_model_blocker_policy_invalid");
	normalizePolicy(value.requestedPolicy as unknown as WorkerModelPolicyInput);
	if (sanitizeSafeReason(value.safeReason, "worker_model_blocker_reason") !== value.safeReason)
		throw new Error("worker_model_blocker_reason_not_safe");
	safeString(value.authRevision, "worker_model_blocker_auth_revision", 256);
	safeString(value.capabilityRevision, "worker_model_blocker_capability_revision", 256);
	safeString(value.policyRevision, "worker_model_blocker_policy_revision", 256);
	safeDigest(value.preflightDigest, "worker_model_blocker_preflight_digest");
	if (value.receiptDigest !== null) safeDigest(value.receiptDigest, "worker_model_blocker_receipt_digest");
	if (typeof value.retryEligible !== "boolean") throw new Error("worker_model_blocker_retry_invalid");
	safeRetryAt(value.retryAt, "worker_model_blocker_retry_at");
	safeNonNegativeInteger(value.desiredWorkers, "worker_model_blocker_desired_workers");
	safeNonNegativeInteger(value.activeWorkers, "worker_model_blocker_active_workers");
	safeNonNegativeInteger(value.idleCapacity, "worker_model_blocker_idle_capacity");
	if (value.idleReason !== null) safeString(value.idleReason, "worker_model_blocker_idle_reason", 512);
	if (value.retryEligible !== (value.retryAt !== null)) throw new Error("worker_model_blocker_retry_binding_invalid");
	safeDigest(value.queuedWorkDigest, "worker_model_blocker_queue_digest");
	if (!isRecord(value.summary) || value.summary.kind !== "blocked_model_capability")
		throw new Error("worker_model_blocker_summary_invalid");
	if (!isRecord(value.projection) || value.projection.kind !== "blocked_model_capability")
		throw new Error("worker_model_blocker_projection_invalid");
	if (
		value.requestedPolicy.policyRevision !== value.policyRevision ||
		value.summary.taskId !== value.taskId ||
		value.summary.goalId !== value.goalId ||
		value.projection.workflowId !== value.workflowId ||
		value.projection.taskId !== value.taskId ||
		value.projection.goalId !== value.goalId ||
		value.projection.blockerDigest !== value.blockerDigest
	)
		throw new Error("worker_model_blocker_binding_invalid");
	const blockerDigest = safeDigest(value.blockerDigest, "worker_model_blocker_digest");
	const { blockerDigest: _ignored, ...withoutDigest } = value as unknown as WorkerModelCapabilityBlocker;
	if (blockerDigest !== digestObject(blockerDigestInput(withoutDigest)))
		throw new Error("worker_model_blocker_digest_invalid");
}

/** Parse a durable worker-model blocker without exposing the gate's private validators. */
export function parseWorkerModelCapabilityBlocker(value: unknown): WorkerModelCapabilityBlocker | undefined {
	try {
		assertBlocker(value);
		return cloneValue(value);
	} catch {
		return undefined;
	}
}

/** Project a validated blocker into a public daemon/session DTO. */
export function projectWorkerModelCapabilityBlocker(
	blocker: WorkerModelCapabilityBlocker,
): WorkerModelCapabilityBlocker {
	assertBlocker(blocker);
	return cloneValue(blocker);
}

/** Parse a host-issued worker admission without trusting caller-owned fields. */
export function parseWorkerModelCapabilityAdmission(value: unknown): WorkerModelAdmissionIntent | undefined {
	try {
		assertAdmission(value);
		return cloneValue(value);
	} catch {
		return undefined;
	}
}

function assertRetryLease(value: unknown): asserts value is WorkerModelCapabilityRetryLease {
	if (!isRecord(value)) throw new Error("worker_model_retry_lease_invalid");
	safeString(value.leaseId, "worker_model_retry_lease_id", 256);
	safeString(value.blockerId, "worker_model_retry_blocker_id", 64);
	safeString(value.authRevision, "worker_model_retry_auth_revision", 256);
	safeString(value.capabilityRevision, "worker_model_retry_capability_revision", 256);
	safeDigest(value.revisionDigest, "worker_model_retry_revision_digest");
	safeString(value.leasedAt, "worker_model_retry_leased_at", 128);
	if (
		value.revisionDigest !==
		digestObject(
			retryLeaseDigestInput({
				blockerId: value.blockerId as string,
				authRevision: value.authRevision as string,
				capabilityRevision: value.capabilityRevision as string,
			}),
		)
	)
		throw new Error("worker_model_retry_revision_digest_invalid");
}

function assertAdmission(value: unknown): asserts value is WorkerModelAdmissionIntent {
	if (!isRecord(value) || value.kind !== "worker_model_admission_intent")
		throw new Error("worker_model_admission_invalid");
	assertWorkflowId(value.workflowId, "worker_model_admission_workflow_id");
	assertWorkflowId(value.taskId, "worker_model_admission_task_id");
	assertWorkflowId(value.goalId, "worker_model_admission_goal_id");
	const attemptId =
		value.attemptId === undefined
			? undefined
			: assertWorkflowId(value.attemptId, "worker_model_admission_attempt_id");
	const executionKey =
		value.executionKey === undefined
			? undefined
			: assertWorkflowId(value.executionKey, "worker_model_admission_execution_key");
	if ((attemptId === undefined) !== (executionKey === undefined))
		throw new Error("worker_model_admission_attempt_binding_incomplete");
	if (!isRecord(value.policy)) throw new Error("worker_model_admission_policy_invalid");
	const policy = normalizePolicy(value.policy as unknown as WorkerModelPolicyInput);
	safeString(value.stateDigest, "worker_model_admission_state_digest", 512);
	assertRevision(value.revision, "worker_model_admission_revision");
	assertEpochRef(value.epochRef, "worker_model_admission_epoch");
	safeString(value.authRevision, "worker_model_admission_auth_revision", 256);
	safeString(value.capabilityRevision, "worker_model_admission_capability_revision", 256);
	safeString(value.policyRevision, "worker_model_admission_policy_revision", 256);
	assertReceiptEnvelope(value.receipt);
	safeDigest(value.receiptDigest, "worker_model_admission_receipt_digest");
	if (value.receiptDigest !== digestObject(value.receipt))
		throw new Error("worker_model_admission_receipt_digest_invalid");
	safeDigest(value.bindingDigest, "worker_model_admission_binding_digest");
	safeDigest(value.authorizationDigest, "worker_model_admission_authorization_digest");
	if (!isRecord(value.childModel)) throw new Error("worker_model_admission_child_model_invalid");
	const child = normalizeChildBinding(value.childModel as unknown as WorkerModelChildModelBinding);
	const admissionDigest = safeDigest(value.admissionDigest, "worker_model_admission_digest");
	const { admissionDigest: _ignored, ...withoutDigest } = value as unknown as WorkerModelAdmissionIntent;
	if (admissionDigest !== digestObject(admissionDigestInput(withoutDigest)))
		throw new Error("worker_model_admission_digest_invalid");
	if (
		child.allowFallback !== false ||
		child.provider !== policy.provider ||
		child.model !== policy.model ||
		child.reasoning !== policy.reasoning ||
		child.authRevision !== value.authRevision ||
		child.capabilityRevision !== value.capabilityRevision ||
		child.policyRevision !== policy.policyRevision ||
		child.receiptDigest !== value.receiptDigest
	)
		throw new Error("worker_model_admission_binding_invalid");
}

function assertQuarantine(value: unknown): asserts value is WorkerModelCapabilityQuarantineIntent {
	if (!isRecord(value) || value.kind !== "worker_model_capability_quarantine")
		throw new Error("worker_model_quarantine_invalid");
	assertWorkflowId(value.workflowId, "worker_model_quarantine_workflow_id");
	assertWorkflowId(value.taskId, "worker_model_quarantine_task_id");
	assertWorkflowId(value.goalId, "worker_model_quarantine_goal_id");
	safeDigest(value.admissionDigest, "worker_model_quarantine_admission_digest");
	if (
		value.reason !== "forged_admission" &&
		value.reason !== "model_selector_mismatch" &&
		value.reason !== "fallback_forbidden" &&
		value.reason !== "revision_mismatch" &&
		value.reason !== "receipt_mismatch"
	)
		throw new Error("worker_model_quarantine_reason_invalid");
	if (!isRecord(value.expected) || !isRecord(value.actual)) throw new Error("worker_model_quarantine_binding_invalid");
	const artifactDigests = value.inadmissibleArtifactDigests;
	if (
		!Array.isArray(artifactDigests) ||
		artifactDigests.some((digest) => typeof digest !== "string" || !DIGEST_PATTERN.test(digest))
	)
		throw new Error("worker_model_quarantine_artifacts_invalid");
	const intentDigest = safeDigest(value.intentDigest, "worker_model_quarantine_digest");
	const { intentDigest: _ignored, ...withoutDigest } = value as unknown as WorkerModelCapabilityQuarantineIntent;
	if (intentDigest !== digestObject(quarantineDigestInput(withoutDigest)))
		throw new Error("worker_model_quarantine_digest_invalid");
}

function assertDurableState(value: unknown, workflowId: string): asserts value is WorkerModelCapabilityDurableState {
	if (!isRecord(value) || value.schemaVersion !== DURABLE_SCHEMA_VERSION || value.workflowId !== workflowId)
		throw new Error("worker_model_capability_state_invalid");
	if (!Array.isArray(value.queuedWork) || !Array.isArray(value.blockers) || !Array.isArray(value.retryLeases))
		throw new Error("worker_model_capability_state_invalid");
	if (!Array.isArray(value.admissions) || !Array.isArray(value.quarantines))
		throw new Error("worker_model_capability_state_invalid");
	for (const queue of value.queuedWork) assertQueueWork(queue);
	for (const blocker of value.blockers) assertBlocker(blocker);
	for (const lease of value.retryLeases) assertRetryLease(lease);
	for (const admission of value.admissions) assertAdmission(admission);
	for (const quarantine of value.quarantines) assertQuarantine(quarantine);
	const queuedKeys = new Set<string>();
	for (const queued of value.queuedWork) {
		const key = `${queued.taskId}\u0000${queued.goalId}`;
		if (queuedKeys.has(key)) throw new Error("worker_model_capability_queue_duplicate");
		queuedKeys.add(key);
	}
	const blockerTasks = new Set<string>();
	for (const blocker of value.blockers) {
		if (blockerTasks.has(blocker.taskId)) throw new Error("worker_model_capability_blocker_duplicate");
		blockerTasks.add(blocker.taskId);
		const queued = value.queuedWork.find(
			(candidate) => candidate.taskId === blocker.taskId && candidate.goalId === blocker.goalId,
		);
		if (queued === undefined || queued.queueDigest !== blocker.queuedWorkDigest)
			throw new Error("worker_model_capability_blocker_queue_binding_invalid");
	}
	const retryLeaseIds = new Set<string>();
	for (const lease of value.retryLeases) {
		if (retryLeaseIds.has(lease.leaseId)) throw new Error("worker_model_capability_retry_duplicate");
		retryLeaseIds.add(lease.leaseId);
		const blocker = value.blockers.find((candidate) => candidate.blockerDigest === lease.blockerId);
		if (blocker === undefined || !blocker.retryEligible)
			throw new Error("worker_model_capability_retry_binding_invalid");
		if (lease.authRevision === blocker.authRevision && lease.capabilityRevision === blocker.capabilityRevision)
			throw new Error("worker_model_capability_retry_revision_unchanged");
	}
	const admissionIds = new Set<string>();
	for (const admission of value.admissions) {
		if (admissionIds.has(admission.admissionDigest)) throw new Error("worker_model_capability_admission_duplicate");
		admissionIds.add(admission.admissionDigest);
		if (
			value.queuedWork.some((queued) => queued.taskId === admission.taskId) ||
			value.blockers.some((blocker) => blocker.taskId === admission.taskId)
		)
			throw new Error("worker_model_capability_admission_queue_binding_invalid");
	}
	const quarantineIds = new Set<string>();
	for (const quarantine of value.quarantines) {
		if (quarantineIds.has(quarantine.intentDigest)) throw new Error("worker_model_capability_quarantine_duplicate");
		quarantineIds.add(quarantine.intentDigest);
	}
}

function snapshotFromState(state: WorkerModelCapabilityDurableState): WorkerModelCapabilityDurableSnapshot {
	return {
		workflowId: state.workflowId,
		queuedWork: cloneValue(state.queuedWork),
		blockers: cloneValue(state.blockers),
		blocker: cloneValue(state.blockers.at(-1) ?? null),
		retryLeases: cloneValue(state.retryLeases),
		admissions: cloneValue(state.admissions),
		quarantines: cloneValue(state.quarantines),
		stateDigest: digestObject(state),
	};
}

function revisionDigest(authRevision: string, capabilityRevision: string): string {
	return digestObject({ authRevision, capabilityRevision });
}

function boundedRetryAt(now: string): string {
	const nowMilliseconds = Date.parse(now);
	if (!Number.isFinite(nowMilliseconds)) throw new Error("worker_model_retry_clock_invalid");
	return new Date(nowMilliseconds + WORKER_MODEL_RETRY_TTL_MILLISECONDS).toISOString();
}

function policyMatches(left: WorkerModelPolicy, right: WorkerModelPolicy): boolean {
	return (
		left.provider === right.provider &&
		left.model === right.model &&
		left.reasoning === right.reasoning &&
		left.allowFallback === false &&
		right.allowFallback === false &&
		left.policyRevision === right.policyRevision
	);
}

function preflightMatches(
	preflight: WorkerModelCapabilityPreflight,
	current: WorkerModelCapabilityPreflight,
	input: WorkerModelCapabilityDispatchInput,
	policy: WorkerModelPolicy,
): boolean {
	return (
		preflight.status === "available" &&
		current.status === "available" &&
		preflight.workflowId === current.workflowId &&
		policyMatches(preflight.policy, policy) &&
		policyMatches(current.policy, policy) &&
		preflight.authenticated &&
		current.authenticated &&
		preflight.authRevision === current.authRevision &&
		preflight.capabilityRevision === current.capabilityRevision &&
		preflight.policyRevision === current.policyRevision &&
		preflight.receiptDigest !== null &&
		preflight.receiptDigest === current.receiptDigest &&
		preflight.stateDigest === input.stateDigest &&
		preflight.revision === input.revision &&
		sameEpoch(preflight.epochRef, input.epochRef) &&
		sameEpoch(current.epochRef, input.epochRef)
	);
}

function safeInspection(
	workflowId: string,
	policy: WorkerModelPolicy,
	input: WorkerModelCapabilityPreflightInput,
	inspection: WorkerModelCapabilityInspection,
): WorkerModelCapabilityPreflight {
	const authRevision = safeString(inspection.authRevision, "worker_model_inspection_auth_revision", 256);
	const capabilityRevision = safeString(
		inspection.capabilityRevision,
		"worker_model_inspection_capability_revision",
		256,
	);
	const policyRevision = safeString(inspection.policyRevision, "worker_model_inspection_policy_revision", 256);
	const safeReason = sanitizeSafeReason(inspection.safeReason, "worker_model_inspection_reason");
	if (typeof inspection.authenticated !== "boolean") throw new Error("worker_model_inspection_authenticated_invalid");
	let receiptDigest: string | null = null;
	let receipt: WorkflowVerifiedHostReceipt | null = null;
	if (inspection.receipt !== null) {
		assertReceiptEnvelope(inspection.receipt);
		receipt = cloneValue(inspection.receipt);
		receiptDigest = digestObject(receipt);
	}
	const available = inspection.authenticated && receiptDigest !== null && policyRevision === policy.policyRevision;
	const desiredWorkers = safeNonNegativeInteger(
		inspection.desiredWorkers ?? 1,
		"worker_model_inspection_desired_workers",
	);
	const activeWorkers = safeNonNegativeInteger(
		inspection.activeWorkers ?? 0,
		"worker_model_inspection_active_workers",
	);
	const idleCapacity = safeNonNegativeInteger(inspection.idleCapacity ?? 0, "worker_model_inspection_idle_capacity");
	const idleReason =
		inspection.idleReason === undefined || inspection.idleReason === null
			? inspection.authenticated
				? null
				: safeReason
			: sanitizeSafeReason(inspection.idleReason, "worker_model_inspection_idle_reason");
	const retryAt = safeRetryAt(inspection.retryAt ?? null, "worker_model_inspection_retry_at");
	const status: WorkerModelCapabilityPreflightStatus = isContractChange(safeReason)
		? "contract_change"
		: available
			? "available"
			: "blocked";
	return makePreflight({
		status,
		workflowId,
		policy,
		authenticated: inspection.authenticated,
		authRevision,
		capabilityRevision,
		policyRevision,
		safeReason,
		receipt,
		receiptDigest,
		desiredWorkers,
		activeWorkers,
		idleCapacity,
		idleReason,
		retryAt,
		stateDigest: input.stateDigest,
		revision: input.revision,
		epochRef: cloneValue(input.epochRef),
	});
}

function unavailableInspection(
	workflowId: string,
	policy: WorkerModelPolicy,
	input: WorkerModelCapabilityPreflightInput,
	reason: string,
): WorkerModelCapabilityPreflight {
	return makePreflight({
		status: isContractChange(reason) ? "contract_change" : "blocked",
		workflowId,
		policy,
		authenticated: false,
		authRevision: "unavailable",
		capabilityRevision: "unavailable",
		policyRevision: policy.policyRevision,
		safeReason: reason,
		receipt: null,
		receiptDigest: null,
		desiredWorkers: 1,
		activeWorkers: 0,
		idleCapacity: 0,
		idleReason: reason,
		retryAt: null,
		stateDigest: input.stateDigest,
		revision: input.revision,
		epochRef: cloneValue(input.epochRef),
	});
}

class WorkerModelCapabilityGateImpl implements WorkerModelCapabilityGate {
	private readonly now: () => string;
	private readonly policy: WorkerModelPolicyInput;

	constructor(private readonly options: WorkerModelCapabilityGateOptions) {
		assertWorkflowRuntimeVersion(options.runtimeVersion);
		assertWorkflowId(options.workflowId, "worker_model_workflow_id");
		if (typeof options.host.inspect !== "function")
			throw new Error(`${CONTRACT_CHANGE_PREFIX} sealed host worker-model capability inspector is required.`);
		this.now = options.now ?? (() => new Date().toISOString());
		this.policy = cloneValue(options.policy);
	}

	async preflight(input: WorkerModelCapabilityPreflightInput): Promise<WorkerModelCapabilityPreflight> {
		const policy = normalizePolicy(this.policy);
		const normalizedInput = this.normalizePreflightInput(input);
		if (typeof this.options.host.authorize !== "function")
			return unavailableInspection(
				this.options.workflowId,
				policy,
				normalizedInput,
				`${CONTRACT_CHANGE_PREFIX} sealed host worker-model capability authorizer is required.`,
			);
		try {
			const inspection = await this.options.host.inspect({
				...normalizedInput,
				workflowId: this.options.workflowId,
				policy,
			});
			return safeInspection(this.options.workflowId, policy, normalizedInput, inspection);
		} catch (error) {
			return unavailableInspection(
				this.options.workflowId,
				policy,
				normalizedInput,
				safeContractReason(error, "worker_model_capability_inspection_failed"),
			);
		}
	}

	async dispatch(input: WorkerModelCapabilityDispatchInput): Promise<WorkerModelCapabilityDispatchResult> {
		const policy = normalizePolicy(this.policy);
		const normalizedInput = this.normalizeDispatchInput(input, policy);
		const durable = this.requireDurableContext();
		return durable.withExclusiveLease(WORKER_MODEL_LEASE_BOUNDARY, async () => {
			const before = await this.readDurableState();
			if (!sameEpoch(normalizedInput.epochRef, durable.epochRef)) {
				const current = unavailableInspection(
					this.options.workflowId,
					policy,
					normalizedInput,
					"worker_model_epoch_stale",
				);
				const queuedWork = makeQueuedWork(normalizedInput, policy);
				const blocker = this.makeBlocker(queuedWork, normalizedInput.preflight, current, current.safeReason);
				await this.persistIfChanged(before, this.upsertBlockedState(before, queuedWork, blocker));
				await this.projectBlocker(before, blocker);
				return { status: "blocked", queuedWork, blocker, contractChange: null };
			}
			const current = await this.inspectForDispatch(normalizedInput, policy);
			const queuedWork = makeQueuedWork(normalizedInput, policy);
			if (!preflightMatches(normalizedInput.preflight, current, normalizedInput, policy)) {
				const safeReason = this.dispatchBlockReason(normalizedInput.preflight, current, policy);
				const blocker = this.makeBlocker(queuedWork, normalizedInput.preflight, current, safeReason);
				const next = this.upsertBlockedState(before, queuedWork, blocker);
				await this.persistIfChanged(before, next);
				await this.projectBlocker(before, blocker);
				return {
					status: "blocked",
					queuedWork,
					blocker,
					contractChange: isContractChange(safeReason) ? safeReason : null,
				};
			}

			if (current.receipt === null || current.receiptDigest === null)
				throw new Error("worker_model_capability_receipt_required");
			const authorizationInput = this.authorizationInput(normalizedInput, policy, current);
			let authorization: WorkerModelCapabilityAuthorization;
			try {
				if (typeof this.options.host.authorize !== "function")
					throw new Error(`${CONTRACT_CHANGE_PREFIX} sealed host worker-model capability authorizer is required.`);
				authorization = await this.options.host.authorize(authorizationInput);
				this.assertAuthorization(authorization, authorizationInput, current);
			} catch (error) {
				const safeReason = safeContractReason(error, "worker_model_capability_authorization_failed");
				const blocker = this.makeBlocker(queuedWork, normalizedInput.preflight, current, safeReason);
				const next = this.upsertBlockedState(before, queuedWork, blocker);
				await this.persistIfChanged(before, next);
				await this.projectBlocker(before, blocker);
				return {
					status: "blocked",
					queuedWork,
					blocker,
					contractChange: isContractChange(safeReason) ? safeReason : null,
				};
			}

			const intent = this.makeAdmissionIntent(normalizedInput, policy, current, authorization);
			const next = this.admittedState(before, queuedWork, intent);
			await this.persistIfChanged(before, next);
			const priorBlocker = before.blockers.find((candidate) => candidate.taskId === queuedWork.taskId);
			if (priorBlocker !== undefined) await this.options.projection?.clear(cloneValue(priorBlocker));
			return { status: "admitted", intent };
		});
	}

	async retry(input: WorkerModelCapabilityRetryInput): Promise<WorkerModelCapabilityRetryResult> {
		const policy = normalizePolicy(this.policy);
		const normalizedInput = this.normalizeRetryInput(input, policy);
		const durable = this.requireDurableContext();
		return durable.withExclusiveLease(WORKER_MODEL_LEASE_BOUNDARY, async () => {
			const before = await this.readDurableState();
			const blocker = before.blockers.find((candidate) => candidate.blockerDigest === normalizedInput.blockerId);
			if (blocker === undefined) throw new Error("worker_model_retry_blocker_not_found");
			if (!sameEpoch(normalizedInput.epochRef, durable.epochRef))
				return { status: "blocked", blocker: cloneValue(blocker) };
			if (!blocker.retryEligible) return { status: "blocked", blocker: cloneValue(blocker) };
			const current = await this.inspectForDispatch(
				{
					...normalizedInput,
					taskId: blocker.taskId,
					goalId: blocker.goalId,
					enqueuedAt: this.now(),
					preflight: normalizedInput.preflight,
				},
				policy,
			);
			if (
				current.status !== "available" ||
				!current.authenticated ||
				current.receiptDigest === null ||
				current.policyRevision !== policy.policyRevision
			) {
				const safeReason = current.safeReason;
				const refreshed = this.makeBlocker(
					before.queuedWork.find((work) => work.taskId === blocker.taskId && work.goalId === blocker.goalId) ??
						makeQueuedWork({ taskId: blocker.taskId, goalId: blocker.goalId, enqueuedAt: this.now() }, policy),
					normalizedInput.preflight,
					current,
					safeReason,
				);
				const next = this.replaceBlocker(before, refreshed);
				await this.persistIfChanged(before, next);
				await this.projectBlocker(before, refreshed);
				return { status: "blocked", blocker: refreshed };
			}
			if (current.authRevision === blocker.authRevision && current.capabilityRevision === blocker.capabilityRevision)
				return { status: "unchanged", blocker: cloneValue(blocker) };
			if (
				normalizedInput.preflight.status !== "available" ||
				normalizedInput.preflight.workflowId !== this.options.workflowId ||
				!policyMatches(normalizedInput.preflight.policy, policy) ||
				normalizedInput.preflight.preflightDigest !==
					digestObject(preflightDigestInput(normalizedInput.preflight)) ||
				normalizedInput.preflight.stateDigest !== normalizedInput.stateDigest ||
				normalizedInput.preflight.revision !== normalizedInput.revision ||
				!sameEpoch(normalizedInput.preflight.epochRef, normalizedInput.epochRef) ||
				normalizedInput.preflight.receiptDigest !== current.receiptDigest ||
				normalizedInput.preflight.authRevision !== current.authRevision ||
				normalizedInput.preflight.capabilityRevision !== current.capabilityRevision
			)
				return { status: "blocked", blocker: cloneValue(blocker) };

			const nextRevisionDigest = revisionDigest(current.authRevision, current.capabilityRevision);
			const existing = before.retryLeases.find((lease) => lease.blockerId === blocker.blockerDigest);
			if (existing !== undefined) return { status: "already_leased", lease: cloneValue(existing) };
			const lease = makeRetryLease({
				leaseId: digestObject({ blockerId: blocker.blockerDigest, revisionDigest: nextRevisionDigest }),
				blockerId: blocker.blockerDigest,
				authRevision: current.authRevision,
				capabilityRevision: current.capabilityRevision,
				leasedAt: this.now(),
			});
			const next: WorkerModelCapabilityDurableState = {
				...before,
				retryLeases: [...before.retryLeases, lease],
			};
			await this.persistIfChanged(before, next);
			return { status: "retry_leased", lease: cloneValue(lease) };
		});
	}

	async handshake(input: WorkerModelCapabilityHandshakeInput): Promise<WorkerModelCapabilityHandshakeResult> {
		const admission = input.admission;
		let expectedAdmission: WorkerModelAdmissionIntent;
		try {
			assertAdmission(admission);
			expectedAdmission = cloneValue(admission);
		} catch {
			const forged = this.forgedAdmissionQuarantine(admission, input.actual);
			await this.appendQuarantine(forged);
			await this.options.quarantine?.(cloneValue(forged));
			return { status: "terminate_quarantine", quarantine: forged };
		}
		const durable = this.requireDurableContext();
		return durable.withExclusiveLease(WORKER_MODEL_LEASE_BOUNDARY, async () => {
			const before = await this.readDurableState();
			const persisted = before.admissions.find(
				(candidate) => candidate.admissionDigest === expectedAdmission.admissionDigest,
			);
			if (persisted === undefined || !sameEpoch(persisted.epochRef, durable.epochRef)) {
				const quarantine = this.makeQuarantine(expectedAdmission, input.actual, "forged_admission");
				const next = this.appendQuarantineState(before, quarantine);
				await this.persistIfChanged(before, next);
				await this.options.quarantine?.(cloneValue(quarantine));
				return { status: "terminate_quarantine", quarantine };
			}
			const actual = normalizeChildBinding(input.actual);
			const reason = bindingMismatchReason(persisted.childModel, actual);
			if (reason === null) return { status: "accepted", admissionDigest: persisted.admissionDigest };
			const quarantine = this.makeQuarantine(persisted, actual, reason);
			const next = this.appendQuarantineState(before, quarantine);
			await this.persistIfChanged(before, next);
			await this.options.quarantine?.(cloneValue(quarantine));
			return { status: "terminate_quarantine", quarantine };
		});
	}

	async readState(): Promise<WorkerModelCapabilityDurableSnapshot> {
		await this.requireDurableContext();
		return snapshotFromState(await this.readDurableState());
	}

	private normalizePreflightInput(input: WorkerModelCapabilityPreflightInput): WorkerModelCapabilityPreflightInput {
		const stateDigest = safeString(input.stateDigest, "worker_model_state_digest", 512);
		const revision = assertRevision(input.revision, "worker_model_revision");
		assertEpochRef(input.epochRef, "worker_model_epoch");
		return { stateDigest, revision, epochRef: cloneValue(input.epochRef) };
	}

	private normalizeDispatchInput(
		input: WorkerModelCapabilityDispatchInput,
		policy: WorkerModelPolicy,
	): WorkerModelCapabilityDispatchInput {
		const base = this.normalizePreflightInput(input);
		const taskId = assertWorkflowId(input.taskId, "worker_model_task_id");
		const goalId = assertWorkflowId(input.goalId, "worker_model_goal_id");
		const enqueuedAt = safeString(input.enqueuedAt, "worker_model_enqueued_at", 128);
		const attemptId =
			input.attemptId === undefined ? undefined : assertWorkflowId(input.attemptId, "worker_model_attempt_id");
		const executionKey =
			input.executionKey === undefined
				? undefined
				: assertWorkflowId(input.executionKey, "worker_model_execution_key");
		if ((attemptId === undefined) !== (executionKey === undefined))
			throw new Error("worker_model_attempt_binding_incomplete");
		this.assertPreflight(input.preflight, policy);
		return {
			...base,
			taskId,
			goalId,
			enqueuedAt,
			...(attemptId === undefined ? {} : { attemptId, executionKey }),
			preflight: cloneValue(input.preflight),
		};
	}

	private normalizeRetryInput(
		input: WorkerModelCapabilityRetryInput,
		policy: WorkerModelPolicy,
	): WorkerModelCapabilityRetryInput {
		const base = this.normalizePreflightInput(input);
		const blockerId = safeDigest(input.blockerId, "worker_model_retry_blocker_id");
		this.assertPreflight(input.preflight, policy);
		return { ...base, blockerId, preflight: cloneValue(input.preflight) };
	}

	private assertPreflight(preflight: WorkerModelCapabilityPreflight, policy: WorkerModelPolicy): void {
		if (
			preflight.workflowId !== this.options.workflowId ||
			!policyMatches(preflight.policy, policy) ||
			preflight.preflightDigest !== digestObject(preflightDigestInput(preflight))
		)
			throw new Error("worker_model_preflight_invalid");
		assertEpochRef(preflight.epochRef, "worker_model_preflight_epoch");
		if (preflight.receipt !== null) {
			assertReceiptEnvelope(preflight.receipt);
			if (preflight.receiptDigest !== digestObject(preflight.receipt))
				throw new Error("worker_model_preflight_receipt_digest_invalid");
		} else if (preflight.receiptDigest !== null) {
			throw new Error("worker_model_preflight_receipt_digest_invalid");
		}
	}

	private requireDurableContext() {
		const durable = this.options.runtimeStore.durableContext;
		if (durable === undefined)
			throw new Error(
				"CONTRACT_CHANGE: worker model capability gate requires WorkflowRuntimeStore durable authority.",
			);
		if (this.options.runtimeStore.identity.workflowId !== this.options.workflowId)
			throw new Error("worker_model_runtime_store_workflow_mismatch");
		if (!sameEpoch(durable.epochRef, this.currentEpoch()))
			throw new Error("worker_model_runtime_store_epoch_invalid");
		return durable;
	}

	private currentEpoch(): WorkflowEpochRef {
		const epoch = this.options.runtimeStore.durableContext?.epochRef;
		if (epoch === undefined) throw new Error("worker_model_runtime_store_epoch_unavailable");
		assertEpochRef(epoch, "worker_model_runtime_store_epoch");
		return epoch;
	}

	private async readDurableState(): Promise<WorkerModelCapabilityDurableState> {
		const durable = this.options.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("worker_model_durable_authority_unavailable");
		const bytes = await durable.auxiliaryStore.read(WORKER_MODEL_CAPABILITY_AUXILIARY_NAME);
		if (bytes === null) return emptyDurableState(this.options.workflowId);
		const parsed = parseCanonicalJsonBytes(bytes);
		assertDurableState(parsed, this.options.workflowId);
		return cloneValue(parsed);
	}

	private async persistIfChanged(
		before: WorkerModelCapabilityDurableState,
		next: WorkerModelCapabilityDurableState,
	): Promise<void> {
		if (digestObject(before) === digestObject(next)) return;
		const durable = this.options.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("worker_model_durable_authority_unavailable");
		await durable.auxiliaryStore.write(WORKER_MODEL_CAPABILITY_AUXILIARY_NAME, canonicalJsonBytes(next));
	}

	private async projectBlocker(
		before: WorkerModelCapabilityDurableState,
		blocker: WorkerModelCapabilityBlocker,
	): Promise<void> {
		if (before.blockers.some((candidate) => candidate.blockerDigest === blocker.blockerDigest)) return;
		await this.options.projection?.append(cloneValue(blocker));
	}

	private async inspectForDispatch(
		input: WorkerModelCapabilityDispatchInput,
		policy: WorkerModelPolicy,
	): Promise<WorkerModelCapabilityPreflight> {
		try {
			const inspection = await this.options.host.inspect({
				workflowId: this.options.workflowId,
				policy,
				stateDigest: input.stateDigest,
				revision: input.revision,
				epochRef: input.epochRef,
			});
			return safeInspection(this.options.workflowId, policy, input, inspection);
		} catch (error) {
			return unavailableInspection(
				this.options.workflowId,
				policy,
				input,
				safeContractReason(error, "worker_model_capability_inspection_failed"),
			);
		}
	}

	private dispatchBlockReason(
		preflight: WorkerModelCapabilityPreflight,
		current: WorkerModelCapabilityPreflight,
		policy: WorkerModelPolicy,
	): string {
		if (isContractChange(current.safeReason)) return current.safeReason;
		if (current.policyRevision !== policy.policyRevision) return "worker_model_policy_revision_mismatch";
		if (current.status !== "available" || !current.authenticated) return current.safeReason;
		if (preflight.status !== "available") return preflight.safeReason;
		if (!policyMatches(preflight.policy, policy) || !policyMatches(current.policy, policy))
			return "worker_model_policy_revision_mismatch";
		if (
			preflight.authRevision !== current.authRevision ||
			preflight.capabilityRevision !== current.capabilityRevision ||
			preflight.receiptDigest !== current.receiptDigest
		)
			return "worker_model_preflight_stale";
		if (
			preflight.stateDigest !== current.stateDigest ||
			preflight.revision !== current.revision ||
			!sameEpoch(preflight.epochRef, current.epochRef)
		)
			return "worker_model_preflight_state_stale";
		return "worker_model_capability_unavailable";
	}

	private makeBlocker(
		queuedWork: WorkerModelQueuedWork,
		preflight: WorkerModelCapabilityPreflight,
		current: WorkerModelCapabilityPreflight,
		safeReason: string,
	): WorkerModelCapabilityBlocker {
		const authRevision = current.authRevision || preflight.authRevision;
		const capabilityRevision = current.capabilityRevision || preflight.capabilityRevision;
		const policyRevision = current.policyRevision || preflight.policyRevision;
		const retryEligible = retryEligibleForReason(safeReason);
		const retryAt = retryEligible ? (current.retryAt ?? preflight.retryAt ?? boundedRetryAt(this.now())) : null;
		const summary: WorkerModelCapabilityBlockerSummary = {
			kind: "blocked_model_capability",
			taskId: queuedWork.taskId,
			goalId: queuedWork.goalId,
			text: `${queuedWork.requestedPolicy.provider}/${queuedWork.requestedPolicy.model} unavailable: ${safeReason}`,
		};
		const blockerBase: Omit<WorkerModelCapabilityBlocker, "blockerDigest"> = {
			kind: "blocked_model_capability",
			workflowId: this.options.workflowId,
			taskId: queuedWork.taskId,
			goalId: queuedWork.goalId,
			requestedPolicy: queuedWork.requestedPolicy,
			safeReason,
			authRevision,
			capabilityRevision,
			policyRevision,
			preflightDigest: preflight.preflightDigest,
			receiptDigest: current.receiptDigest ?? preflight.receiptDigest,
			retryEligible,
			retryAt,
			desiredWorkers: current.desiredWorkers,
			activeWorkers: current.activeWorkers,
			idleCapacity: current.idleCapacity,
			idleReason: current.idleReason ?? safeReason,
			queuedWorkDigest: queuedWork.queueDigest,
			summary,
			projection: {
				kind: "blocked_model_capability",
				workflowId: this.options.workflowId,
				taskId: queuedWork.taskId,
				goalId: queuedWork.goalId,
				queueState: "queued",
				blockerDigest: "pending",
			},
		};
		const blockerDigest = digestObject(blockerDigestInput(blockerBase));
		return makeBlocker({
			...blockerBase,
			projection: { ...blockerBase.projection, blockerDigest },
		});
	}

	private authorizationInput(
		input: WorkerModelCapabilityDispatchInput,
		policy: WorkerModelPolicy,
		current: WorkerModelCapabilityPreflight,
	): WorkerModelCapabilityAuthorizationInput {
		if (current.receipt === null || current.receiptDigest === null)
			throw new Error("worker_model_capability_receipt_required");
		const attemptBinding =
			input.attemptId === undefined
				? {}
				: {
						taskAttemptBinding: {
							taskId: input.taskId,
							attemptId: input.attemptId,
							executionKey: input.executionKey,
						},
					};
		const resourceDigest = digestObject({
			workflowId: this.options.workflowId,
			taskId: input.taskId,
			goalId: input.goalId,
			policy,
			...attemptBinding,
		});
		const operationDigest = digestObject({
			operation: "worker_model_dispatch",
			taskId: input.taskId,
			goalId: input.goalId,
			preflightDigest: input.preflight.preflightDigest,
			...attemptBinding,
		});
		const bindingDigest = digestObject({
			capability: WORKER_MODEL_CAPABILITY,
			workflowId: this.options.workflowId,
			resourceDigest,
			operationDigest,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
		});
		return {
			workflowId: this.options.workflowId,
			policy,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
			capability: WORKER_MODEL_CAPABILITY,
			receipt: current.receipt,
			bindingDigest,
			resourceDigest,
			operationDigest,
		};
	}

	private assertAuthorization(
		authorization: WorkerModelCapabilityAuthorization,
		input: WorkerModelCapabilityAuthorizationInput,
		current: WorkerModelCapabilityPreflight,
	): void {
		assertReceiptEnvelope(authorization.receipt);
		const capabilityBinding = authorization.receipt.capabilityBinding;
		if (
			authorization.authenticatedPrincipal.length === 0 ||
			authorization.capability !== WORKER_MODEL_CAPABILITY ||
			authorization.workflowId !== this.options.workflowId ||
			authorization.bindingDigest !== input.bindingDigest ||
			authorization.resourceDigest !== input.resourceDigest ||
			authorization.operationDigest !== input.operationDigest ||
			authorization.authRevision !== current.authRevision ||
			authorization.capabilityRevision !== current.capabilityRevision ||
			authorization.policyRevision !== current.policyRevision ||
			authorization.authorizationDigest.length === 0 ||
			capabilityBinding?.resourceDigest !== input.resourceDigest ||
			capabilityBinding?.operationDigest !== input.operationDigest ||
			authorization.receipt.bindingDigest !== input.bindingDigest
		)
			throw new Error("worker_model_capability_authorization_invalid");
	}

	private makeAdmissionIntent(
		input: WorkerModelCapabilityDispatchInput,
		policy: WorkerModelPolicy,
		current: WorkerModelCapabilityPreflight,
		authorization: WorkerModelCapabilityAuthorization,
	): WorkerModelAdmissionIntent {
		if (current.receipt === null || current.receiptDigest === null)
			throw new Error("worker_model_capability_receipt_required");
		const receiptDigest = digestObject(authorization.receipt);
		const childModel = childBindingFromAdmission(
			policy,
			current.authRevision,
			current.capabilityRevision,
			current.policyRevision,
			receiptDigest,
		);
		return makeAdmissionIntent({
			kind: "worker_model_admission_intent",
			workflowId: this.options.workflowId,
			taskId: input.taskId,
			goalId: input.goalId,
			...(input.attemptId === undefined ? {} : { attemptId: input.attemptId, executionKey: input.executionKey }),
			policy,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
			authRevision: current.authRevision,
			capabilityRevision: current.capabilityRevision,
			policyRevision: current.policyRevision,
			receipt: authorization.receipt,
			receiptDigest,
			bindingDigest: authorization.bindingDigest,
			authorizationDigest: authorization.authorizationDigest,
			childModel,
		});
	}

	private admittedState(
		before: WorkerModelCapabilityDurableState,
		queuedWork: WorkerModelQueuedWork,
		intent: WorkerModelAdmissionIntent,
	): WorkerModelCapabilityDurableState {
		const admissions = before.admissions.some((candidate) => candidate.admissionDigest === intent.admissionDigest)
			? before.admissions
			: [...before.admissions, intent];
		return {
			...before,
			queuedWork: before.queuedWork.filter((work) => work.taskId !== queuedWork.taskId),
			blockers: before.blockers.filter((blocker) => blocker.taskId !== queuedWork.taskId),
			retryLeases: before.retryLeases.filter(
				(lease) =>
					!before.blockers.some(
						(blocker) => blocker.taskId === queuedWork.taskId && blocker.blockerDigest === lease.blockerId,
					),
			),
			admissions,
		};
	}

	private upsertBlockedState(
		before: WorkerModelCapabilityDurableState,
		queuedWork: WorkerModelQueuedWork,
		blocker: WorkerModelCapabilityBlocker,
	): WorkerModelCapabilityDurableState {
		const priorBlockerIds = new Set(
			before.blockers
				.filter((candidate) => candidate.taskId === queuedWork.taskId)
				.map((candidate) => candidate.blockerDigest),
		);
		return {
			...before,
			queuedWork: [...before.queuedWork.filter((work) => work.taskId !== queuedWork.taskId), queuedWork],
			blockers: [...before.blockers.filter((candidate) => candidate.taskId !== queuedWork.taskId), blocker],
			retryLeases: before.retryLeases.filter((lease) => !priorBlockerIds.has(lease.blockerId)),
		};
	}

	private replaceBlocker(
		before: WorkerModelCapabilityDurableState,
		blocker: WorkerModelCapabilityBlocker,
	): WorkerModelCapabilityDurableState {
		const priorBlockerIds = new Set(
			before.blockers
				.filter((candidate) => candidate.taskId === blocker.taskId)
				.map((candidate) => candidate.blockerDigest),
		);
		return {
			...before,
			blockers: [
				...before.blockers.filter(
					(candidate) => candidate.blockerDigest !== blocker.blockerDigest && candidate.taskId !== blocker.taskId,
				),
				blocker,
			],
			retryLeases: before.retryLeases.filter((lease) => !priorBlockerIds.has(lease.blockerId)),
		};
	}

	private makeQuarantine(
		admission: WorkerModelAdmissionIntent,
		actualInput: WorkerModelChildModelBinding,
		reason: WorkerModelCapabilityQuarantineIntent["reason"],
	): WorkerModelCapabilityQuarantineIntent {
		const actual = normalizeChildBinding(actualInput);
		return makeQuarantineIntent({
			kind: "worker_model_capability_quarantine",
			workflowId: admission.workflowId,
			taskId: admission.taskId,
			goalId: admission.goalId,
			admissionDigest: admission.admissionDigest,
			reason,
			expected: admission.childModel,
			actual,
			inadmissibleArtifactDigests: actual.artifactDigests ?? [],
		});
	}

	private forgedAdmissionQuarantine(
		admission: WorkerModelAdmissionIntent,
		actualInput: WorkerModelChildModelBinding,
	): WorkerModelCapabilityQuarantineIntent {
		const safeAdmission: Record<string, unknown> = isRecord(admission) ? admission : {};
		const workflowId =
			typeof safeAdmission.workflowId === "string" ? safeAdmission.workflowId : this.options.workflowId;
		const taskId = typeof safeAdmission.taskId === "string" ? safeAdmission.taskId : "<forged-task>";
		const goalId = typeof safeAdmission.goalId === "string" ? safeAdmission.goalId : "<forged-goal>";
		const candidateAdmissionDigest =
			typeof safeAdmission.admissionDigest === "string" ? safeAdmission.admissionDigest : "forged";
		const admissionDigest = DIGEST_PATTERN.test(candidateAdmissionDigest)
			? candidateAdmissionDigest
			: digestObject({ forgedAdmission: candidateAdmissionDigest, workflowId, taskId, goalId });
		const expected: WorkerModelChildModelBinding = {
			provider: "<forged>",
			model: "<forged>",
			reasoning: "<forged>",
			allowFallback: true,
			authRevision: "<forged>",
			capabilityRevision: "<forged>",
			policyRevision: "<forged>",
			receiptDigest: "<forged>",
		};
		const actual = normalizeChildBinding(actualInput);
		return makeQuarantineIntent({
			kind: "worker_model_capability_quarantine",
			workflowId,
			taskId,
			goalId,
			admissionDigest,
			reason: "forged_admission",
			expected,
			actual,
			inadmissibleArtifactDigests: actual.artifactDigests ?? [],
		});
	}

	private appendQuarantineState(
		before: WorkerModelCapabilityDurableState,
		quarantine: WorkerModelCapabilityQuarantineIntent,
	): WorkerModelCapabilityDurableState {
		if (before.quarantines.some((candidate) => candidate.intentDigest === quarantine.intentDigest)) return before;
		return { ...before, quarantines: [...before.quarantines, quarantine] };
	}

	private async appendQuarantine(quarantine: WorkerModelCapabilityQuarantineIntent): Promise<void> {
		const durable = this.requireDurableContext();
		await durable.withExclusiveLease(WORKER_MODEL_LEASE_BOUNDARY, async () => {
			const before = await this.readDurableState();
			await this.persistIfChanged(before, this.appendQuarantineState(before, quarantine));
		});
	}
}

/** Create a durable worker-model capability gate. */
export function createWorkerModelCapabilityGate(options: WorkerModelCapabilityGateOptions): WorkerModelCapabilityGate {
	return new WorkerModelCapabilityGateImpl(options);
}
