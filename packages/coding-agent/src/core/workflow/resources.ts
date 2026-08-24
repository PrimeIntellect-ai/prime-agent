import type {
	WorkflowArtifactPublisher,
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowCloudAvailabilityRequest,
	WorkflowCloudAvailabilityResponse,
	WorkflowCloudCapacityReceipt,
	WorkflowControlCapacityVector,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowExecutionCeilingInput,
	WorkflowExecutionCeilings,
	WorkflowHostReceiptConsumerContext,
	WorkflowResourceAdmission,
	WorkflowResourceEnvelope,
	WorkflowResourceEnvelopeDraft,
	WorkflowResourceGrantLedger,
	WorkflowResourceVector,
	WorkflowRuntimeConfigSnapshot,
	WorkflowTaskResourceGrant,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import {
	canonicalJsonBytes,
	DEFAULT_WORKFLOW_EXECUTION_CEILINGS,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
} from "./contracts.js";
import type { WorkflowProfileResolution } from "./profile.js";

export type {
	WorkflowAcceleratorResource,
	WorkflowProviderResource,
	WorkflowResourceEnforcementClass,
	WorkflowRuntimeConfigSnapshot,
} from "./contracts.js";
export type {
	WorkflowPreparedSettingsTransaction,
	WorkflowSettings,
	WorkflowSettingsMigrationPlan,
	WorkflowSettingsStore,
	WorkflowSettingsValue,
} from "./migrations.js";
export type { WorkflowProfileApprovalReceipt, WorkflowProfileInput, WorkflowProfileResolution } from "./profile.js";
export { resolveWorkflowProfile } from "./profile.js";

const UNKNOWN_CLOUD_POOLS = [
	"authority",
	"billing",
	"credential",
	"egress",
	"pricing",
	"quota",
	"rate_limit",
	"region",
	"termination",
] as const;

const RESOURCE_SCALAR_KEYS = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
] as const;

const CONTROL_KEYS = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const satisfies readonly (keyof WorkflowControlCapacityVector)[];

export interface WorkflowCapacitySnapshot {
	workflowId: string;
	cloudRequest: WorkflowCloudAvailabilityRequest;
	cloudRequestRef: WorkflowArtifactRef;
	cloudRequestDigest: string;
	cloudResponseDigest: string;
	localVector: WorkflowResourceVector;
	localCapacityRef: WorkflowArtifactRef;
	cloudVector: WorkflowResourceVector;
	cloudAvailability: WorkflowCloudAvailabilityResponse;
	cloudUnknownPoolIds: readonly string[];
	capacityReceipt: WorkflowCloudCapacityReceipt | null;
	observedAt: string;
	inventoryDigest: string;
}

export interface WorkflowCapacityProbe {
	local(): Promise<WorkflowResourceVector>;
	cloud(request: WorkflowCloudAvailabilityRequest): Promise<WorkflowCloudAvailabilityResponse>;
}

export interface WorkflowCloudEvidenceVerifier {
	verify(input: {
		workflowId: string;
		request: WorkflowCloudAvailabilityRequest;
		response: WorkflowCloudAvailabilityResponse;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
		trustedNow: string;
	}): Promise<void>;
}

export interface WorkflowCapacityDiscoveryInput {
	workflowId: string;
	probe: WorkflowCapacityProbe;
	request: WorkflowCloudAvailabilityRequest;
	artifactPublisher: WorkflowArtifactPublisher;
	artifactResolver: WorkflowArtifactResolver;
	cloudEvidenceVerifier: WorkflowCloudEvidenceVerifier;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentStateDigest: string;
	currentRevision: number;
}

export interface WorkflowControlPlaneReserve {
	control: WorkflowControlCapacityVector;
	verifier: WorkflowControlCapacityVector;
	redTeam: WorkflowControlCapacityVector;
	recovery: WorkflowControlCapacityVector;
	approval: WorkflowControlCapacityVector;
}

export interface WorkflowResourceEnvelopeInput {
	capacity: WorkflowCapacitySnapshot;
	authenticatedLedger: WorkflowResourceGrantLedger;
	controlPlaneReserve: WorkflowResourceVector;
	controlPlaneReserveCapacity: WorkflowControlCapacityVector;
	declaredControlCapacity: WorkflowControlCapacityVector;
	hostDerivedControlCapacity: WorkflowControlCapacityVector;
	executionCeilings: WorkflowExecutionCeilingInput | undefined;
	declaredVector: WorkflowResourceVector;
	requiredPoolIds: readonly string[];
	localPricingDigest: string;
	profile: WorkflowProfileResolution;
	controlPlaneReserves?: Partial<WorkflowControlPlaneReserve>;
}

export interface WorkflowResourceEnvelopeStore {
	compareAndSwap(input: {
		workflowId: string;
		expectedDraftDigest: string;
		envelope: WorkflowResourceEnvelope;
		decisionRef: WorkflowDecisionRef;
		epochRef: WorkflowEpochRef;
		trustedNow: string;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
	}): Promise<WorkflowResourceEnvelope>;
	read(workflowId: string): Promise<WorkflowResourceEnvelope | null>;
}

export const zeroWorkflowResourceVector = (): WorkflowResourceVector => ({
	cpuMilliCores: 0,
	memoryBytes: 0,
	diskBytes: 0,
	ioWeight: 0,
	accelerators: [],
	providers: [],
	networkEgressBytes: 0,
	wallMilliseconds: 0,
	monetaryMicrounits: 0,
});

export const zeroWorkflowControlCapacity = (): WorkflowControlCapacityVector => ({
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
});

export function assertFiniteWorkflowResourceVector(vector: WorkflowResourceVector): void {
	for (const key of RESOURCE_SCALAR_KEYS) {
		const value = vector[key];
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error(`Workflow resource vector ${key} must be a finite non-negative safe integer.`);
	}
	const acceleratorIdentities = new Set<string>();
	for (const accelerator of vector.accelerators) {
		const identity = `${accelerator.poolId}\u0000${accelerator.deviceType}`;
		if (
			typeof accelerator.poolId !== "string" ||
			typeof accelerator.deviceType !== "string" ||
			accelerator.poolId.length === 0 ||
			accelerator.deviceType.length === 0 ||
			!Number.isSafeInteger(accelerator.count) ||
			accelerator.count < 0 ||
			!Number.isSafeInteger(accelerator.memoryBytes) ||
			accelerator.memoryBytes < 0
		) {
			throw new Error(
				"Workflow accelerator capacity must have an exact identity and finite non-negative safe integers.",
			);
		}
		if (acceleratorIdentities.has(identity))
			throw new Error("Workflow accelerator capacity contains a duplicate pool and device identity.");
		acceleratorIdentities.add(identity);
	}
	const providerIdentities = new Set<string>();
	for (const provider of vector.providers) {
		if (
			typeof provider.poolId !== "string" ||
			provider.poolId.length === 0 ||
			!Number.isSafeInteger(provider.concurrentRequests) ||
			provider.concurrentRequests < 0 ||
			!Number.isSafeInteger(provider.requestsPerMinute) ||
			provider.requestsPerMinute < 0 ||
			!Number.isSafeInteger(provider.totalRequests) ||
			provider.totalRequests < 0 ||
			!Number.isSafeInteger(provider.inputTokens) ||
			provider.inputTokens < 0 ||
			!Number.isSafeInteger(provider.outputTokens) ||
			provider.outputTokens < 0
		) {
			throw new Error(
				"Workflow provider capacity must have an exact identity and finite non-negative safe integers.",
			);
		}
		if (providerIdentities.has(provider.poolId))
			throw new Error("Workflow provider capacity contains a duplicate pool identity.");
		providerIdentities.add(provider.poolId);
	}
}

export function assertFiniteWorkflowControlCapacity(capacity: WorkflowControlCapacityVector): void {
	for (const key of CONTROL_KEYS) {
		const value = capacity[key];
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error(`Workflow control capacity ${key} must be a finite non-negative integer.`);
	}
}

function assertFiniteExecutionCeilings(ceilings: WorkflowExecutionCeilings): void {
	const values = [
		ceilings.maxWorkflowWallMilliseconds,
		ceilings.maxWorkflowTokens,
		ceilings.maxModelCalls,
		ceilings.maxTaskAttempts,
		ceilings.maxPlannerCycles,
		ceilings.maxDistinctStrategiesPerRequirement,
		ceilings.maxAnalysisAttemptsPerRequirement,
		ceilings.maxRecoveryAttemptsPerEffectClass,
	];
	if (
		values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
		ceilings.renewalRequiresUserApproval !== true
	) {
		throw new Error("Workflow execution ceilings must be finite and approval-bound.");
	}
}

export function resolveWorkflowExecutionCeilings(
	input: WorkflowExecutionCeilingInput | undefined,
): WorkflowExecutionCeilings {
	const ceilings = { ...DEFAULT_WORKFLOW_EXECUTION_CEILINGS, ...(input ?? {}) };
	assertFiniteExecutionCeilings(ceilings);
	return ceilings;
}

function sumControlCapacity(
	left: WorkflowControlCapacityVector,
	right: WorkflowControlCapacityVector,
): WorkflowControlCapacityVector {
	assertFiniteWorkflowControlCapacity(left);
	assertFiniteWorkflowControlCapacity(right);
	const result = zeroWorkflowControlCapacity();
	for (const key of CONTROL_KEYS) {
		const value = left[key] + right[key];
		if (!Number.isSafeInteger(value))
			throw new Error("Workflow control-capacity sum exceeds the safe integer bound.");
		result[key] = value;
	}
	return result;
}

export function sumWorkflowControlCapacity(
	grants: readonly WorkflowTaskResourceGrant[],
): WorkflowControlCapacityVector {
	return grants.reduce(
		(total, grant) => sumControlCapacity(total, grant.controlCapacity),
		zeroWorkflowControlCapacity(),
	);
}

function maxControlCapacity(
	left: WorkflowControlCapacityVector,
	right: WorkflowControlCapacityVector,
): WorkflowControlCapacityVector {
	assertFiniteWorkflowControlCapacity(left);
	assertFiniteWorkflowControlCapacity(right);
	const result = zeroWorkflowControlCapacity();
	for (const key of CONTROL_KEYS) result[key] = Math.max(left[key], right[key]);
	return result;
}

function subtractControlCapacity(
	total: WorkflowControlCapacityVector,
	reserve: WorkflowControlCapacityVector,
): WorkflowControlCapacityVector {
	assertFiniteWorkflowControlCapacity(total);
	assertFiniteWorkflowControlCapacity(reserve);
	const result = zeroWorkflowControlCapacity();
	for (const key of CONTROL_KEYS) {
		if (total[key] < reserve[key])
			throw new Error("Control-plane reserve exceeds the authenticated control capacity.");
		result[key] = total[key] - reserve[key];
	}
	return result;
}

function mergeResourceItems<T extends { poolId: string }>(
	left: readonly T[],
	right: readonly T[],
	key: (item: T) => string,
): T[] {
	const result = new Map<string, T>();
	for (const item of [...left, ...right]) {
		const itemKey = key(item);
		if (!result.has(itemKey)) result.set(itemKey, item);
	}
	return [...result.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

export function maxWorkflowResourceVectors(
	left: WorkflowResourceVector,
	right: WorkflowResourceVector,
): WorkflowResourceVector {
	assertFiniteWorkflowResourceVector(left);
	assertFiniteWorkflowResourceVector(right);
	const accelerators = mergeResourceItems(
		left.accelerators,
		right.accelerators,
		(item) => `${item.poolId}\u0000${item.deviceType}`,
	);
	const providers = mergeResourceItems(left.providers, right.providers, (item) => item.poolId);
	return {
		cpuMilliCores: Math.max(left.cpuMilliCores, right.cpuMilliCores),
		memoryBytes: Math.max(left.memoryBytes, right.memoryBytes),
		diskBytes: Math.max(left.diskBytes, right.diskBytes),
		ioWeight: Math.max(left.ioWeight, right.ioWeight),
		accelerators: accelerators.map((identity) => {
			const entries = [...left.accelerators, ...right.accelerators].filter(
				(item) => item.poolId === identity.poolId && item.deviceType === identity.deviceType,
			);
			return {
				poolId: identity.poolId,
				deviceType: identity.deviceType,
				count: Math.max(...entries.map((item) => item.count)),
				memoryBytes: Math.max(...entries.map((item) => item.memoryBytes)),
			};
		}),
		providers: providers.map((identity) => {
			const entries = [...left.providers, ...right.providers].filter((item) => item.poolId === identity.poolId);
			return {
				poolId: identity.poolId,
				concurrentRequests: Math.max(...entries.map((item) => item.concurrentRequests)),
				requestsPerMinute: Math.max(...entries.map((item) => item.requestsPerMinute)),
				totalRequests: Math.max(...entries.map((item) => item.totalRequests)),
				inputTokens: Math.max(...entries.map((item) => item.inputTokens)),
				outputTokens: Math.max(...entries.map((item) => item.outputTokens)),
				idempotency: entries.some((item) => item.idempotency === "none")
					? "none"
					: entries.some((item) => item.idempotency === "host_reconciled")
						? "host_reconciled"
						: "provider_native",
			};
		}),
		networkEgressBytes: Math.max(left.networkEgressBytes, right.networkEgressBytes),
		wallMilliseconds: Math.max(left.wallMilliseconds, right.wallMilliseconds),
		monetaryMicrounits: Math.max(left.monetaryMicrounits, right.monetaryMicrounits),
	};
}

function sumWorkflowResourceVectors(vectors: readonly WorkflowResourceVector[]): WorkflowResourceVector {
	const result = zeroWorkflowResourceVector();
	for (const vector of vectors) {
		assertFiniteWorkflowResourceVector(vector);
		for (const key of RESOURCE_SCALAR_KEYS) {
			const value = result[key] + vector[key];
			if (!Number.isSafeInteger(value) || value < 0)
				throw new Error("Workflow resource sum exceeds the safe integer bound.");
			result[key] = value;
		}
		result.accelerators = [...result.accelerators, ...vector.accelerators];
		result.providers = [...result.providers, ...vector.providers];
	}
	result.accelerators = mergeResourceItems(
		result.accelerators,
		[],
		(item) => `${item.poolId}\u0000${item.deviceType}`,
	).map((identity) => {
		const entries = result.accelerators.filter(
			(item) => item.poolId === identity.poolId && item.deviceType === identity.deviceType,
		);
		return {
			poolId: identity.poolId,
			deviceType: identity.deviceType,
			count: entries.reduce((sum, item) => {
				const value = sum + item.count;
				if (!Number.isSafeInteger(value))
					throw new Error("Workflow accelerator sum exceeds the safe integer bound.");
				return value;
			}, 0),
			memoryBytes: Math.max(...entries.map((item) => item.memoryBytes)),
		};
	});
	result.providers = mergeResourceItems(result.providers, [], (item) => item.poolId).map((identity) => {
		const entries = result.providers.filter((item) => item.poolId === identity.poolId);
		return {
			poolId: identity.poolId,
			concurrentRequests: sumResourceDimension(entries.map((item) => item.concurrentRequests)),
			requestsPerMinute: sumResourceDimension(entries.map((item) => item.requestsPerMinute)),
			totalRequests: sumResourceDimension(entries.map((item) => item.totalRequests)),
			inputTokens: sumResourceDimension(entries.map((item) => item.inputTokens)),
			outputTokens: sumResourceDimension(entries.map((item) => item.outputTokens)),
			idempotency: entries.some((item) => item.idempotency === "none")
				? "none"
				: entries.some((item) => item.idempotency === "host_reconciled")
					? "host_reconciled"
					: "provider_native",
		};
	});
	return result;
}

function sumResourceDimension(values: readonly number[]): number {
	return values.reduce((sum, value) => {
		const next = sum + value;
		if (!Number.isSafeInteger(next)) throw new Error("Workflow provider sum exceeds the safe integer bound.");
		return next;
	}, 0);
}

function resourceIdentitySet(vector: WorkflowResourceVector): { accelerators: Set<string>; providers: Set<string> } {
	return {
		accelerators: new Set(vector.accelerators.map((item) => `${item.poolId}\u0000${item.deviceType}`)),
		providers: new Set(vector.providers.map((item) => item.poolId)),
	};
}

function assertExactResourcePoolIdentities(requested: WorkflowResourceVector, observed: WorkflowResourceVector): void {
	const requestedIdentities = resourceIdentitySet(requested);
	const observedIdentities = resourceIdentitySet(observed);
	if (
		requestedIdentities.accelerators.size !== observedIdentities.accelerators.size ||
		[...requestedIdentities.accelerators].some((identity) => !observedIdentities.accelerators.has(identity)) ||
		requestedIdentities.providers.size !== observedIdentities.providers.size ||
		[...requestedIdentities.providers].some((identity) => !observedIdentities.providers.has(identity))
	)
		throw new Error("Cloud capacity provider and accelerator identities do not match the typed request.");
}

function assertResourceVectorWithinCapacity(reserve: WorkflowResourceVector, capacity: WorkflowResourceVector): void {
	assertFiniteWorkflowResourceVector(reserve);
	assertFiniteWorkflowResourceVector(capacity);
	for (const key of RESOURCE_SCALAR_KEYS) {
		if (reserve[key] > capacity[key])
			throw new Error("Control-plane resource reserve exceeds the authenticated capacity.");
	}
	const capacityAccelerators = new Map(
		capacity.accelerators.map((item) => [`${item.poolId}\u0000${item.deviceType}`, item]),
	);
	for (const item of reserve.accelerators) {
		const available = capacityAccelerators.get(`${item.poolId}\u0000${item.deviceType}`);
		if (available === undefined || item.count > available.count || item.memoryBytes > available.memoryBytes)
			throw new Error("Control-plane accelerator reserve does not match authenticated capacity identity.");
	}
	const capacityProviders = new Map(capacity.providers.map((item) => [item.poolId, item]));
	for (const item of reserve.providers) {
		const available = capacityProviders.get(item.poolId);
		if (
			available === undefined ||
			item.concurrentRequests > available.concurrentRequests ||
			item.requestsPerMinute > available.requestsPerMinute ||
			item.totalRequests > available.totalRequests ||
			item.inputTokens > available.inputTokens ||
			item.outputTokens > available.outputTokens
		)
			throw new Error("Control-plane provider reserve does not match authenticated capacity identity.");
	}
}

function assertLedgerBinding(ledger: WorkflowResourceGrantLedger): void {
	if (
		ledger.canonicalLedgerDigest !== ledger.canonicalLedgerRef.digest ||
		ledger.canonicalPoolLedger.digest !== ledger.canonicalPoolLedger.artifactRef.digest ||
		ledger.canonicalPoolLedger.workflowId !== ledger.workflowId ||
		ledger.canonicalPoolLedger.approvedEnvelopeDigest !== ledger.approvedEnvelopeDigest
	) {
		throw new Error("Resource admission requires an authenticated canonical pool ledger.");
	}
}

function canonicalPoolProjection(ledger: WorkflowResourceGrantLedger): WorkflowResourceVector {
	const pools = Object.values(ledger.canonicalPoolLedger.approvedPools);
	return sumWorkflowResourceVectors(pools);
}

function findUnmatchedResourcePools(declared: WorkflowResourceVector, ledger: WorkflowResourceGrantLedger): string[] {
	const approvedPools = Object.values(ledger.canonicalPoolLedger.approvedPools);
	const acceleratorIdentities = new Set(
		approvedPools.flatMap((pool) => pool.accelerators.map((item) => `${item.poolId}\u0000${item.deviceType}`)),
	);
	const providerPoolIds = new Set(approvedPools.flatMap((pool) => pool.providers.map((item) => item.poolId)));
	return [
		...declared.accelerators
			.filter((item) => !acceleratorIdentities.has(`${item.poolId}\u0000${item.deviceType}`))
			.map((item) => `accelerator:${item.poolId}:${item.deviceType}`),
		...declared.providers
			.filter((item) => !providerPoolIds.has(item.poolId))
			.map((item) => `provider:${item.poolId}`),
	]
		.filter((poolId, index, poolIds) => poolIds.indexOf(poolId) === index)
		.sort();
}

export function deriveWorkflowResourceAdmission(input: {
	declaredVector: WorkflowResourceVector;
	authenticatedLedger: WorkflowResourceGrantLedger;
	declaredControlCapacity: WorkflowControlCapacityVector;
	hostDerivedControlCapacity: WorkflowControlCapacityVector;
	unknownPoolIds: readonly string[];
}): WorkflowResourceAdmission {
	assertFiniteWorkflowResourceVector(input.declaredVector);
	assertFiniteWorkflowControlCapacity(input.declaredControlCapacity);
	assertFiniteWorkflowControlCapacity(input.hostDerivedControlCapacity);
	assertLedgerBinding(input.authenticatedLedger);
	const unknownPoolIds = [
		...new Set([
			...input.unknownPoolIds,
			...findUnmatchedResourcePools(input.declaredVector, input.authenticatedLedger),
		]),
	].sort();
	const hostDerivedConservativeVector =
		unknownPoolIds.length === 0 ? canonicalPoolProjection(input.authenticatedLedger) : zeroWorkflowResourceVector();
	const reservedVector = maxWorkflowResourceVectors(input.declaredVector, hostDerivedConservativeVector);
	const reservedControlCapacity = maxControlCapacity(input.declaredControlCapacity, input.hostDerivedControlCapacity);
	const enforcementClass: WorkflowResourceAdmission["enforcementClass"] =
		unknownPoolIds.length === 0 ? "isolated_metered" : "exclusive_unisolated";
	const admitted = unknownPoolIds.length === 0;
	const zeroControlCapacity = zeroWorkflowControlCapacity() as WorkflowControlCapacityVector & {
		processSlots: 0;
		childSessionSlots: 0;
		modelCallSlots: 0;
		modelInputTokens: 0;
		modelOutputTokens: 0;
		verificationSlots: 0;
		redTeamSlots: 0;
		recoverySlots: 0;
	};
	const hasControlCapacity = Object.values(reservedControlCapacity).some((value) => value > 0);
	const capacityGrant = hasControlCapacity
		? {
				kind: "control" as const,
				grantId: `grant:control:${input.authenticatedLedger.revision}`,
				resourceVector: reservedVector,
				controlCapacity: reservedControlCapacity,
				canonicalPoolLedgerRef: input.authenticatedLedger.canonicalLedgerRef,
				grantDigest: digestObject({
					kind: "control",
					reservedVector,
					reservedControlCapacity,
					ledger: input.authenticatedLedger.canonicalLedgerDigest,
				}),
			}
		: {
				kind: "worker" as const,
				grantId: `grant:worker:${input.authenticatedLedger.revision}`,
				resourceVector: reservedVector,
				controlCapacity: zeroControlCapacity,
				canonicalPoolLedgerRef: input.authenticatedLedger.canonicalLedgerRef,
				grantDigest: digestObject({
					kind: "worker",
					reservedVector,
					ledger: input.authenticatedLedger.canonicalLedgerDigest,
				}),
			};
	const withoutDigest = {
		capacityGrant,
		canonicalPoolLedgerRef: input.authenticatedLedger.canonicalLedgerRef,
		controlCapacity: capacityGrant.controlCapacity,
		controlCapacityProjectionDigest: digestObject({
			capacityGrant: capacityGrant.controlCapacity,
			declared: input.declaredControlCapacity,
			host: input.hostDerivedControlCapacity,
		}),
		declaredVector: input.declaredVector,
		hostDerivedConservativeVector,
		reservedVector,
		declaredControlCapacity: input.declaredControlCapacity,
		hostDerivedControlCapacity: input.hostDerivedControlCapacity,
		reservedControlCapacity,
		derivationPolicyDigest: digestObject({
			kind: "component_wise_max",
			unknownPoolIds,
			canonicalLedgerDigest: input.authenticatedLedger.canonicalLedgerDigest,
		}),
		enforcementClass,
		unknownPoolIds,
		admitted,
	};
	return {
		...withoutDigest,
		canonicalLedgerRef: input.authenticatedLedger.canonicalLedgerRef,
		canonicalLedgerDigest: input.authenticatedLedger.canonicalLedgerDigest,
		admissionDigest: digestObject(withoutDigest),
	};
}

function assertCloudRequest(request: WorkflowCloudAvailabilityRequest): void {
	if (
		request.requestId.length === 0 ||
		request.provider.length === 0 ||
		request.accountRef.length === 0 ||
		request.region.length === 0 ||
		request.credentialRef.length === 0 ||
		request.egressPolicyDigest.length === 0 ||
		request.quotaPolicyDigest.length === 0 ||
		request.pricingPolicyDigest.length === 0 ||
		request.billingPolicyDigest.length === 0 ||
		request.terminationPolicyDigest.length === 0 ||
		!Number.isSafeInteger(request.timeoutMilliseconds) ||
		request.timeoutMilliseconds < 1 ||
		!Number.isFinite(Date.parse(request.requestedAt))
	) {
		throw new Error("Cloud capacity request is incomplete or not finite.");
	}
	assertFiniteWorkflowResourceVector(request.requestedVector);
}

async function verifyReceiptIfAvailable(input: WorkflowCapacityDiscoveryInput): Promise<void> {
	if (input.trustedClockReceipt.receiptKind !== "clock")
		throw new Error("Capacity observation requires a host-issued clock receipt.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: digestObject(input.request),
		receipt: input.trustedClockReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedClockReceipt.issuedAt,
	});
}

async function verifyImmutableArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
): Promise<WorkflowArtifactReadResult> {
	if (ref.digest.length === 0 || ref.sizeBytes <= 0)
		throw new Error("Workflow capacity evidence has an invalid artifact reference.");
	const artifact = await resolver.resolve(ref);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		digestObject(artifact.envelope.ref) !== digestObject(ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	) {
		throw new Error("Workflow capacity evidence is not immutable and content-addressed.");
	}
	return artifact;
}

function cloudResponseBindingDigest(
	requestDigest: string,
	response: WorkflowCloudAvailabilityResponse,
	responseBytes: Readonly<Uint8Array>,
): string {
	if (
		response.responseArtifactRef === null ||
		response.capacityArtifactRef === null ||
		response.pricingArtifactRef === null ||
		response.credentialArtifactRef === null ||
		response.quotaArtifactRef === null ||
		response.rateLimitArtifactRef === null ||
		response.billingArtifactRef === null ||
		response.egressArtifactRef === null ||
		response.terminationArtifactRef === null
	)
		throw new Error("Cloud response binding is missing a typed evidence reference.");
	return digestObject({
		requestDigest,
		responseArtifactRef: response.responseArtifactRef,
		capacityArtifactRef: response.capacityArtifactRef,
		pricingArtifactRef: response.pricingArtifactRef,
		credentialArtifactRef: response.credentialArtifactRef,
		quotaArtifactRef: response.quotaArtifactRef,
		rateLimitArtifactRef: response.rateLimitArtifactRef,
		billingArtifactRef: response.billingArtifactRef,
		egressArtifactRef: response.egressArtifactRef,
		terminationArtifactRef: response.terminationArtifactRef,
		capacityDigest: response.capacityArtifactRef.digest,
		pricingDigest: response.pricingArtifactRef.digest,
		credentialDigest: response.credentialArtifactRef.digest,
		quotaDigest: response.quotaArtifactRef.digest,
		rateLimitDigest: response.rateLimitArtifactRef.digest,
		billingDigest: response.billingArtifactRef.digest,
		egressDigest: response.egressArtifactRef.digest,
		terminationDigest: response.terminationArtifactRef.digest,
		responseDigest: sha256Hex(responseBytes),
	});
}

function assertAvailableCapacitySnapshotBinding(capacity: WorkflowCapacitySnapshot): void {
	if (capacity.cloudAvailability.status !== "available") return;
	const response = capacity.cloudAvailability;
	const receipt = capacity.capacityReceipt;
	if (receipt === null) throw new Error("Available cloud capacity requires an authenticated capacity receipt.");
	if (capacity.cloudUnknownPoolIds.length !== 0)
		throw new Error("Available cloud capacity cannot carry unknown cloud pool metadata.");
	if (
		capacity.cloudRequestDigest !== digestObject(capacity.cloudRequest) ||
		capacity.cloudResponseDigest !== digestObject(response)
	)
		throw new Error("Available cloud capacity is not bound to the exact request and response snapshot.");
	const requestBytes = canonicalJsonBytes(capacity.cloudRequest);
	if (
		capacity.cloudRequestRef.digest !== sha256Hex(requestBytes) ||
		capacity.cloudRequestRef.sizeBytes !== requestBytes.byteLength
	)
		throw new Error("Available cloud capacity request evidence is not content-addressed.");
	if (
		response.requestDigest !== capacity.cloudRequestDigest ||
		response.provider !== capacity.cloudRequest.provider ||
		response.accountRef !== capacity.cloudRequest.accountRef ||
		response.region !== capacity.cloudRequest.region ||
		response.capacityArtifactRef === null ||
		response.pricingArtifactRef === null ||
		response.credentialArtifactRef === null ||
		response.quotaArtifactRef === null ||
		response.rateLimitArtifactRef === null ||
		response.billingArtifactRef === null ||
		response.egressArtifactRef === null ||
		response.terminationArtifactRef === null ||
		response.responseArtifactRef === null ||
		response.responseReceipt === null ||
		response.validUntil === null ||
		response.pricingDigest === null ||
		response.authorityDigest === null ||
		response.responseKeyId === null ||
		response.responseMac === null ||
		response.responseChecksum === null ||
		response.pricingDigest.length === 0 ||
		response.authorityDigest.length === 0 ||
		response.responseKeyId.length === 0 ||
		response.responseMac.length === 0 ||
		response.responseChecksum.length === 0
	)
		throw new Error("Available cloud capacity lacks an exact authenticated response binding.");
	assertFiniteWorkflowResourceVector(capacity.cloudVector);
	assertExactResourcePoolIdentities(capacity.cloudRequest.requestedVector, capacity.cloudVector);
	if (response.responseReceipt.payloadDigest !== response.responseArtifactRef.digest)
		throw new Error("Available cloud response receipt is not bound to its response artifact.");
	const responseRefs: readonly [WorkflowArtifactRef, WorkflowArtifactRef][] = [
		[receipt.capacityArtifactRef, response.capacityArtifactRef],
		[receipt.pricingArtifactRef, response.pricingArtifactRef],
		[receipt.credentialArtifactRef, response.credentialArtifactRef],
		[receipt.quotaArtifactRef, response.quotaArtifactRef],
		[receipt.rateLimitArtifactRef, response.rateLimitArtifactRef],
		[receipt.billingArtifactRef, response.billingArtifactRef],
		[receipt.egressArtifactRef, response.egressArtifactRef],
		[receipt.terminationArtifactRef, response.terminationArtifactRef],
		[receipt.responseArtifactRef, response.responseArtifactRef],
	];
	if (
		responseRefs.some(([receiptRef, responseRef]) => digestObject(receiptRef) !== digestObject(responseRef)) ||
		receipt.workflowId !== capacity.workflowId ||
		receipt.requestDigest !== capacity.cloudRequestDigest ||
		digestObject(receipt.responseReceipt) !== digestObject(response.responseReceipt) ||
		digestObject(receipt.capacityVector) !== digestObject(capacity.cloudVector) ||
		receipt.observedAt !== capacity.observedAt ||
		receipt.validUntil !== response.validUntil ||
		receipt.finalEnvelopeDecisionRef !== null ||
		receipt.finalEnvelopeDigest !== "unbound" ||
		receipt.trustedClockReceipt.receiptKind !== "clock" ||
		receipt.trustedClockReceipt.workflowId !== capacity.workflowId ||
		receipt.trustedClockReceipt.bindingDigest !== capacity.cloudRequestDigest ||
		receipt.trustedClockReceipt.issuedAt !== capacity.observedAt ||
		receipt.receiptDigest !== digestObject({ ...receipt, receiptDigest: "" })
	)
		throw new Error("Available cloud capacity receipt is not bound to the current authenticated snapshot.");
	const observedAt = Date.parse(capacity.observedAt);
	const validUntil = Date.parse(response.validUntil);
	if (
		!Number.isFinite(observedAt) ||
		!Number.isFinite(validUntil) ||
		validUntil <= observedAt ||
		receipt.ttlMilliseconds !== validUntil - observedAt
	)
		throw new Error("Available cloud capacity receipt has an invalid validity interval.");
	const expectedInventoryDigest = digestObject({
		workflowId: capacity.workflowId,
		localVector: capacity.localVector,
		localCapacityRef: capacity.localCapacityRef,
		cloudVector: capacity.cloudVector,
		response,
		capacityReceipt: receipt,
	});
	if (capacity.inventoryDigest !== expectedInventoryDigest)
		throw new Error("Available cloud capacity inventory is not bound to its authenticated snapshot.");
}

function assertUnauthenticatedCloudCapacityIsZero(capacity: WorkflowCapacitySnapshot): void {
	if (capacity.cloudAvailability.status === "available") return;
	assertFiniteWorkflowResourceVector(capacity.cloudVector);
	if (digestObject(capacity.cloudVector) !== digestObject(zeroWorkflowResourceVector()))
		throw new Error("Unauthenticated cloud capacity must be zero and cannot be allocated.");
}

function resolveCloudUnknownPoolIds(capacity: WorkflowCapacitySnapshot): readonly string[] {
	if (capacity.cloudAvailability.status !== "unknown") return capacity.cloudUnknownPoolIds;
	return [...new Set([...capacity.cloudUnknownPoolIds, ...UNKNOWN_CLOUD_POOLS])].sort();
}

export async function discoverWorkflowCapacity(
	input: WorkflowCapacityDiscoveryInput,
): Promise<WorkflowCapacitySnapshot> {
	if (input.workflowId.length === 0) throw new Error("Workflow capacity discovery requires a workflow identity.");
	assertCloudRequest(input.request);
	await verifyReceiptIfAvailable(input);
	const requestBytes = canonicalJsonBytes(input.request);
	const requestArtifact = await input.artifactPublisher.publish({
		workflowId: input.workflowId,
		payloadKind: "evidence",
		bytes: requestBytes,
		codec: "canonical_json",
		sourceEventSequence: 0,
		idempotencyKey: `cloud-request:${input.request.requestId}`,
	});
	if (
		requestArtifact.envelope.ref.digest !== sha256Hex(requestBytes) ||
		requestArtifact.envelope.ref.sizeBytes !== requestBytes.byteLength
	)
		throw new Error("Cloud capacity request was not durably published before probing.");
	const localVector = await input.probe.local();
	assertFiniteWorkflowResourceVector(localVector);
	const response = await input.probe.cloud(input.request);
	await input.cloudEvidenceVerifier.verify({
		workflowId: input.workflowId,
		request: input.request,
		response,
		receiptContext: input.receiptContext,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedClockReceipt.issuedAt,
	});
	if (
		response.requestDigest !== digestObject(input.request) ||
		response.provider !== input.request.provider ||
		response.accountRef !== input.request.accountRef ||
		response.region !== input.request.region
	)
		throw new Error("Cloud availability response request digest or identity does not match the typed request.");
	let cloudVector = zeroWorkflowResourceVector();
	if (response.status === "available") {
		if (
			response.capacityArtifactRef === null ||
			response.pricingArtifactRef === null ||
			response.credentialArtifactRef === null ||
			response.quotaArtifactRef === null ||
			response.rateLimitArtifactRef === null ||
			response.billingArtifactRef === null ||
			response.egressArtifactRef === null ||
			response.terminationArtifactRef === null ||
			response.responseArtifactRef === null ||
			response.responseReceipt === null ||
			response.validUntil === null ||
			response.pricingDigest === null ||
			response.authorityDigest === null ||
			response.responseKeyId === null ||
			response.responseMac === null ||
			response.responseChecksum === null ||
			response.pricingDigest.length === 0 ||
			response.authorityDigest.length === 0 ||
			response.responseKeyId.length === 0 ||
			response.responseMac.length === 0 ||
			response.responseChecksum.length === 0
		)
			throw new Error("Available cloud capacity lacks a typed evidence or validity proof.");
		const capacityArtifact = await verifyImmutableArtifact(input.artifactResolver, response.capacityArtifactRef);
		const responseArtifact = await verifyImmutableArtifact(input.artifactResolver, response.responseArtifactRef);
		if (response.responseReceipt.payloadDigest !== response.responseArtifactRef.digest)
			throw new Error("Cloud response receipt is not bound to the response artifact.");
		parseCanonicalJsonBytes(responseArtifact.bytes);
		await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: cloudResponseBindingDigest(
				digestObject(input.request),
				response,
				responseArtifact.bytes,
			),
			receipt: response.responseReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedClockReceipt.issuedAt,
		});
		const value = parseCanonicalJsonBytes(capacityArtifact.bytes);
		if (Array.isArray(value) || value === null || typeof value !== "object")
			throw new Error("Cloud capacity artifact is not a resource vector.");
		cloudVector = value as unknown as WorkflowResourceVector;
		assertFiniteWorkflowResourceVector(cloudVector);
		assertExactResourcePoolIdentities(input.request.requestedVector, cloudVector);
	}
	const localBytes = canonicalJsonBytes(localVector);
	const localArtifact = await input.artifactPublisher.publish({
		workflowId: input.workflowId,
		payloadKind: "evidence",
		bytes: localBytes,
		codec: "canonical_json",
		sourceEventSequence: 0,
		idempotencyKey: `local-capacity:${input.request.requestId}`,
	});
	if (
		localArtifact.envelope.ref.digest !== sha256Hex(localBytes) ||
		localArtifact.envelope.ref.sizeBytes !== localBytes.byteLength
	)
		throw new Error("Local capacity artifact is not content-addressed.");
	const cloudUnknownPoolIds =
		response.status === "unknown"
			? [...UNKNOWN_CLOUD_POOLS]
			: response.status === "unavailable"
				? ["unavailable"]
				: [];
	let capacityReceipt: WorkflowCloudCapacityReceipt | null = null;
	if (response.status === "available") {
		if (
			response.capacityArtifactRef === null ||
			response.pricingArtifactRef === null ||
			response.credentialArtifactRef === null ||
			response.quotaArtifactRef === null ||
			response.rateLimitArtifactRef === null ||
			response.billingArtifactRef === null ||
			response.egressArtifactRef === null ||
			response.terminationArtifactRef === null ||
			response.responseArtifactRef === null ||
			response.responseReceipt === null ||
			response.validUntil === null
		)
			throw new Error(
				"Available cloud capacity lacks one of its typed authority, quota, billing, rate-limit, egress, termination, or response proofs.",
			);
		const observedAt = input.trustedClockReceipt.issuedAt;
		const validUntil = Date.parse(response.validUntil);
		const observed = Date.parse(observedAt);
		if (!Number.isFinite(validUntil) || !Number.isFinite(observed) || validUntil <= observed)
			throw new Error("Cloud capacity validity interval is stale.");
		capacityReceipt = {
			workflowId: input.workflowId,
			requestDigest: digestObject(input.request),
			capacityArtifactRef: response.capacityArtifactRef,
			pricingArtifactRef: response.pricingArtifactRef,
			credentialArtifactRef: response.credentialArtifactRef,
			quotaArtifactRef: response.quotaArtifactRef,
			rateLimitArtifactRef: response.rateLimitArtifactRef,
			billingArtifactRef: response.billingArtifactRef,
			egressArtifactRef: response.egressArtifactRef,
			terminationArtifactRef: response.terminationArtifactRef,
			responseArtifactRef: response.responseArtifactRef,
			responseReceipt: response.responseReceipt,
			capacityVector: cloudVector,
			trustedClockReceipt: input.trustedClockReceipt,
			observedAt,
			validUntil: response.validUntil,
			ttlMilliseconds: validUntil - observed,
			finalEnvelopeDecisionRef: null,
			finalEnvelopeDigest: "unbound",
			receiptDigest: "",
		};
		capacityReceipt.receiptDigest = digestObject(capacityReceipt);
	}
	return {
		workflowId: input.workflowId,
		cloudRequest: input.request,
		cloudRequestRef: requestArtifact.envelope.ref,
		cloudRequestDigest: digestObject(input.request),
		cloudResponseDigest: digestObject(response),
		localVector,
		localCapacityRef: localArtifact.envelope.ref,
		cloudVector,
		cloudAvailability: response,
		cloudUnknownPoolIds,
		capacityReceipt,
		observedAt: input.trustedClockReceipt.issuedAt,
		inventoryDigest: digestObject({
			workflowId: input.workflowId,
			localVector,
			localCapacityRef: localArtifact.envelope.ref,
			cloudVector,
			response,
			capacityReceipt,
		}),
	};
}

function resolveControlReserve(input: WorkflowResourceEnvelopeInput): WorkflowControlCapacityVector {
	const explicit = input.controlPlaneReserves;
	if (explicit === undefined) return input.controlPlaneReserveCapacity;
	let total = zeroWorkflowControlCapacity();
	for (const reserve of [
		explicit.control,
		explicit.verifier,
		explicit.redTeam,
		explicit.recovery,
		explicit.approval,
	]) {
		if (reserve !== undefined) total = sumControlCapacity(total, reserve);
	}
	if (digestObject(total) !== digestObject(input.controlPlaneReserveCapacity))
		throw new Error(
			"Named control, verifier, red-team, recovery, and approval reserves do not match the aggregate control reserve.",
		);
	return total;
}

export function buildWorkflowResourceEnvelope(input: WorkflowResourceEnvelopeInput): WorkflowResourceEnvelopeDraft {
	assertAvailableCapacitySnapshotBinding(input.capacity);
	assertUnauthenticatedCloudCapacityIsZero(input.capacity);
	const executionCeilings = resolveWorkflowExecutionCeilings(input.executionCeilings);
	assertFiniteWorkflowResourceVector(input.controlPlaneReserve);
	assertFiniteWorkflowControlCapacity(input.controlPlaneReserveCapacity);
	const reserveCapacity = resolveControlReserve(input);
	const admission = deriveWorkflowResourceAdmission({
		declaredVector: input.declaredVector,
		authenticatedLedger: input.authenticatedLedger,
		declaredControlCapacity: input.declaredControlCapacity,
		hostDerivedControlCapacity: input.hostDerivedControlCapacity,
		unknownPoolIds: resolveCloudUnknownPoolIds(input.capacity),
	});
	if (!admission.admitted) throw new Error("Resource envelope cannot admit unknown or unenforceable resource pools.");
	const workerCapacity = subtractControlCapacity(admission.reservedControlCapacity, reserveCapacity);
	if (
		input.profile.resolved === "unresolved" ||
		input.profile.approvalDecisionRef === null ||
		input.profile.approvalReceipt === null ||
		!Number.isSafeInteger(input.profile.maxWorkers) ||
		input.profile.maxWorkers < 1 ||
		input.profile.maxWorkers > workerCapacity.processSlots
	)
		throw new Error("Resource envelope profile is not approved or worker capacity is not allocatable.");
	if (
		input.capacity.workflowId !== input.authenticatedLedger.workflowId ||
		input.profile.approvalDecisionRef.decisionScope.kind !== "workflow" ||
		input.profile.approvalDecisionRef.decisionScope.workflowId !== input.capacity.workflowId ||
		input.profile.approvalReceipt.workflowId !== input.capacity.workflowId
	)
		throw new Error("Resource envelope capacity, ledger, and approved profile workflow identities must match.");
	assertResourceVectorWithinCapacity(input.controlPlaneReserve, admission.reservedVector);
	const validFrom = Date.parse(input.capacity.observedAt);
	const validUntilText =
		input.capacity.cloudAvailability.validUntil ??
		new Date(validFrom + input.capacity.cloudRequest.timeoutMilliseconds).toISOString();
	const validUntil = Date.parse(validUntilText);
	if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validUntil <= validFrom)
		throw new Error("Resource envelope validity interval is invalid.");
	if (input.localPricingDigest.length === 0) throw new Error("Local capacity requires an explicit pricing digest.");
	const providerQuotaSnapshotRef =
		input.capacity.cloudAvailability.status === "available"
			? input.capacity.cloudAvailability.capacityArtifactRef
			: input.capacity.localCapacityRef;
	const pricingDigest =
		input.capacity.cloudAvailability.status === "available"
			? input.capacity.cloudAvailability.pricingDigest
			: input.localPricingDigest;
	if (providerQuotaSnapshotRef === null || pricingDigest === null)
		throw new Error("Resource envelope capacity or pricing proof is missing.");
	const draftWithoutDigest = {
		envelopeId: `envelope:${input.capacity.cloudRequest.requestId}`,
		resources: admission.reservedVector,
		controlPlaneReserve: input.controlPlaneReserve,
		controlPlaneReserveCapacity: reserveCapacity,
		controlCapacity: admission.reservedControlCapacity,
		workerCapacity,
		processSlots: input.profile.maxWorkers,
		childSessionSlots: Math.min(input.profile.maxWorkers, workerCapacity.childSessionSlots),
		candidateSlots: input.profile.maxWorkers,
		executionCeilings,
		providerQuotaSnapshotRef,
		inventoryDigest: input.capacity.inventoryDigest,
		pricingDigest,
		terminationPolicyDigest: input.capacity.cloudRequest.terminationPolicyDigest,
		billingReconciliationPolicyDigest: input.capacity.cloudRequest.billingPolicyDigest,
		egressPolicyDigest: input.capacity.cloudRequest.egressPolicyDigest,
		validFrom: input.capacity.observedAt,
		validUntil: validUntilText,
		capacityReceipt: input.capacity.capacityReceipt,
		approvalDecisionRef: null,
		canonicalLedgerRef: admission.canonicalLedgerRef,
		canonicalLedgerDigest: admission.canonicalLedgerDigest,
	};
	return {
		...draftWithoutDigest,
		draftDigest: digestWorkflowResourceEnvelopeDraft(draftWithoutDigest, input.capacity.workflowId),
	};
}

function digestWorkflowResourceEnvelopeDraft(
	draftFields: Omit<WorkflowResourceEnvelopeDraft, "draftDigest">,
	workflowId: string,
): string {
	return digestObject({ ...draftFields, workflowId });
}

export function bindWorkflowResourceDecision(
	draft: WorkflowResourceEnvelopeDraft,
	decisionRef: WorkflowDecisionRef,
	expectedEpoch: WorkflowEpochRef,
	expectedWorkflowId: string,
): WorkflowResourceEnvelope {
	const { draftDigest, ...draftFields } = draft;
	if (
		expectedWorkflowId.length === 0 ||
		decisionRef.decisionScope.kind !== "workflow" ||
		decisionRef.decisionScope.workflowId !== expectedWorkflowId ||
		decisionRef.storeEpoch !== expectedEpoch.storeEpoch ||
		decisionRef.coordinatorEpoch !== expectedEpoch.coordinatorEpoch ||
		decisionRef.decisionDigest.length === 0 ||
		draft.approvalDecisionRef !== null ||
		draftDigest !== digestWorkflowResourceEnvelopeDraft(draftFields, expectedWorkflowId)
	)
		throw new Error("Resource decision is not bound to the exact draft, workflow, and epoch.");
	const envelopeWithoutDigest = { ...draftFields, approvalDecisionRef: decisionRef };
	return { ...envelopeWithoutDigest, envelopeDigest: digestObject(envelopeWithoutDigest) };
}

export async function verifyWorkflowCloudCapacityReceipt(
	receipt: WorkflowCloudCapacityReceipt,
	input: {
		workflowId: string;
		decisionRef: WorkflowDecisionRef;
		trustedNow: string;
		requestDigest: string;
		receiptContext: WorkflowHostReceiptConsumerContext;
		currentStateDigest: string;
		currentRevision: number;
		finalEnvelopeDigest?: string;
	},
): Promise<void> {
	if (
		receipt.workflowId !== input.workflowId ||
		receipt.requestDigest !== input.requestDigest ||
		receipt.finalEnvelopeDecisionRef === null ||
		digestObject(receipt.finalEnvelopeDecisionRef) !== digestObject(input.decisionRef) ||
		(input.finalEnvelopeDigest !== undefined && receipt.finalEnvelopeDigest !== input.finalEnvelopeDigest) ||
		receipt.ttlMilliseconds <= 0 ||
		receipt.finalEnvelopeDigest.length === 0 ||
		receipt.trustedClockReceipt.receiptKind !== "clock" ||
		receipt.receiptDigest !== digestObject({ ...receipt, receiptDigest: "" })
	)
		throw new Error("Cloud capacity receipt is stale or not bound to the exact approved envelope.");
	const trustedNow = Date.parse(input.trustedNow);
	const observedAt = Date.parse(receipt.observedAt);
	const validUntil = Date.parse(receipt.validUntil);
	if (
		!Number.isFinite(trustedNow) ||
		!Number.isFinite(observedAt) ||
		!Number.isFinite(validUntil) ||
		receipt.observedAt !== receipt.trustedClockReceipt.issuedAt ||
		validUntil <= observedAt ||
		trustedNow >= validUntil ||
		receipt.ttlMilliseconds !== validUntil - observedAt
	)
		throw new Error("Cloud capacity receipt validity is stale at the trusted host time.");
	const artifacts = await Promise.all(
		[
			receipt.capacityArtifactRef,
			receipt.pricingArtifactRef,
			receipt.credentialArtifactRef,
			receipt.quotaArtifactRef,
			receipt.rateLimitArtifactRef,
			receipt.billingArtifactRef,
			receipt.egressArtifactRef,
			receipt.terminationArtifactRef,
			receipt.responseArtifactRef,
		].map((ref) => verifyImmutableArtifact(input.receiptContext.artifactResolver, ref)),
	);
	for (const artifact of artifacts) {
		const parsed = parseCanonicalJsonBytes(artifact.bytes);
		if (sha256Hex(artifact.bytes) !== artifact.envelope.ref.digest)
			throw new Error("Cloud capacity receipt evidence is not content-addressed.");
		if (canonicalJsonBytes(parsed).some((byte, index) => byte !== artifact.bytes[index]))
			throw new Error("Cloud capacity receipt evidence is not canonical.");
	}
	const capacityValue = parseCanonicalJsonBytes(artifacts[0].bytes) as unknown as WorkflowResourceVector;
	assertFiniteWorkflowResourceVector(capacityValue);
	if (digestObject(capacityValue) !== digestObject(receipt.capacityVector))
		throw new Error("Cloud capacity receipt vector is not recomputed from its signed bytes.");
	if (receipt.responseReceipt.payloadDigest !== receipt.responseArtifactRef.digest)
		throw new Error("Cloud response receipt is not bound to its response artifact.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: cloudResponseBindingDigest(
			receipt.requestDigest,
			{
				requestDigest: receipt.requestDigest,
				status: "available",
				provider: "",
				accountRef: "",
				region: "",
				capacityArtifactRef: receipt.capacityArtifactRef,
				pricingArtifactRef: receipt.pricingArtifactRef,
				pricingDigest: null,
				authorityDigest: null,
				credentialArtifactRef: receipt.credentialArtifactRef,
				quotaArtifactRef: receipt.quotaArtifactRef,
				rateLimitArtifactRef: receipt.rateLimitArtifactRef,
				billingArtifactRef: receipt.billingArtifactRef,
				egressArtifactRef: receipt.egressArtifactRef,
				terminationArtifactRef: receipt.terminationArtifactRef,
				responseArtifactRef: receipt.responseArtifactRef,
				responseReceipt: receipt.responseReceipt,
				responseKeyId: "bound",
				responseMac: "bound",
				responseChecksum: "bound",
				validUntil: receipt.validUntil,
				reasonCode: "reported_available",
			},
			artifacts[8].bytes,
		),
		receipt: receipt.responseReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: receipt.requestDigest,
		receipt: receipt.trustedClockReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
}

export async function publishWorkflowResourceEnvelope(input: {
	workflowId: string;
	draft: WorkflowResourceEnvelopeDraft;
	decisionRef: WorkflowDecisionRef;
	expectedEpoch: WorkflowEpochRef;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	store: WorkflowResourceEnvelopeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentStateDigest: string;
	currentRevision: number;
}): Promise<WorkflowResourceEnvelope> {
	if (input.trustedClockReceipt.receiptKind !== "clock")
		throw new Error("Resource envelope publication requires a host-issued clock receipt.");
	const unboundEnvelope = bindWorkflowResourceDecision(
		input.draft,
		input.decisionRef,
		input.expectedEpoch,
		input.workflowId,
	);
	const receiptDraft =
		unboundEnvelope.capacityReceipt === null
			? null
			: {
					...unboundEnvelope.capacityReceipt,
					finalEnvelopeDecisionRef: input.decisionRef,
					finalEnvelopeDigest: "",
					receiptDigest: "",
				};
	const envelopePreimage = {
		...unboundEnvelope,
		capacityReceipt: receiptDraft,
		envelopeDigest: "",
	};
	const envelopeDigest = digestObject(envelopePreimage);
	const capacityReceipt =
		receiptDraft === null
			? null
			: {
					...receiptDraft,
					finalEnvelopeDigest: envelopeDigest,
					receiptDigest: digestObject({ ...receiptDraft, finalEnvelopeDigest: envelopeDigest, receiptDigest: "" }),
				};
	const envelope = { ...unboundEnvelope, capacityReceipt, envelopeDigest };
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: digestObject({
			workflowId: input.workflowId,
			draftDigest: input.draft.draftDigest,
			decisionRef: input.decisionRef,
			epochRef: input.expectedEpoch,
		}),
		receipt: input.trustedClockReceipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedClockReceipt.issuedAt,
	});
	if (envelope.capacityReceipt !== null)
		await verifyWorkflowCloudCapacityReceipt(envelope.capacityReceipt, {
			workflowId: input.workflowId,
			decisionRef: input.decisionRef,
			trustedNow: input.trustedClockReceipt.issuedAt,
			requestDigest: envelope.capacityReceipt.requestDigest,
			receiptContext: input.receiptContext,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			finalEnvelopeDigest: envelope.envelopeDigest,
		});
	const published = await input.store.compareAndSwap({
		workflowId: input.workflowId,
		expectedDraftDigest: input.draft.draftDigest,
		envelope,
		decisionRef: input.decisionRef,
		epochRef: input.expectedEpoch,
		trustedNow: input.trustedClockReceipt.issuedAt,
		receiptContext: input.receiptContext,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
	});
	if (
		published.envelopeDigest !== envelope.envelopeDigest ||
		published.approvalDecisionRef.decisionDigest !== input.decisionRef.decisionDigest
	)
		throw new Error("Resource envelope final binding changed during host CAS.");
	return published;
}

export function getWorkflowRuntimeConfigSnapshotDigest(snapshot: WorkflowRuntimeConfigSnapshot): string {
	return snapshot.resolvedConfigDigest;
}
