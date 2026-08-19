import {
	digestObject,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostPrincipalCapabilityAuthorizer,
	type WorkflowHostReceiptCapability,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";

/** Roles that may be admitted by the pure work-conflict planner. */
export type WorkConflictRole = "writer" | "test_oracle" | "red_team" | "ops_monitor";

/** Scalar resource dimensions accounted for by task requests and capacity snapshots. */
export type WorkConflictResourceDimension =
	| "cpuMilliCores"
	| "memoryBytes"
	| "diskBytes"
	| "ioWeight"
	| "networkEgressBytes"
	| "wallMilliseconds"
	| "monetaryMicrounits";

/** Host-controlled dimensions that cannot be inferred from worker count. */
export type WorkConflictControlDimension =
	| "processSlots"
	| "childSessionSlots"
	| "modelCallSlots"
	| "modelInputTokens"
	| "modelOutputTokens"
	| "verificationSlots"
	| "redTeamSlots"
	| "recoverySlots";

/** A finite non-negative scalar demand or capacity vector. */
export type WorkConflictResourceVector = Readonly<Record<WorkConflictResourceDimension, number>>;

/** A finite non-negative host-control demand or capacity vector. */
export type WorkConflictControlVector = Readonly<Record<WorkConflictControlDimension, number>>;

/** A finite accelerator request against one authenticated accelerator pool. */
export interface WorkConflictAcceleratorRequest {
	poolId: string;
	quantity: number;
	memoryBytes: number;
}

/** An authenticated accelerator pool. */
export interface WorkConflictAcceleratorPool extends WorkConflictAcceleratorRequest {
	poolId: string;
}

/** Provider quota dimensions consumed by one task request. */
export interface WorkConflictProviderRequest {
	poolId: string;
	concurrentRequests: number;
	requestsPerMinute: number;
	totalRequests: number;
	inputTokens: number;
	outputTokens: number;
	idempotency: "provider_native" | "host_reconciled" | "none";
}

/** An authenticated provider quota pool. */
export interface WorkConflictProviderPool extends WorkConflictProviderRequest {
	poolId: string;
}

/** Closed resource request schema used by every ready or active task. */
export interface WorkConflictResourceRequest {
	resources: WorkConflictResourceVector;
	acceleratorPools: readonly WorkConflictAcceleratorRequest[];
	providerPools: readonly WorkConflictProviderRequest[];
	controlCapacity: WorkConflictControlVector;
}

/** Capacity context whose receipt is authorized by the central host-principal seam. */
export interface WorkConflictAuthenticatedCapacity {
	schemaId: "work-conflict-capacity-v1";
	resources: WorkConflictResourceVector;
	acceleratorPools: readonly WorkConflictAcceleratorPool[];
	providerPools: readonly WorkConflictProviderPool[];
	controlCapacity: WorkConflictControlVector;
	protectedResourceReserve: WorkConflictResourceVector;
	protectedControlReserve: WorkConflictControlVector;
	snapshotDigest: string;
}

/** Central host-principal seam that authorizes finite dispatch capacity and path evidence. */
export interface WorkConflictHostAuthorization {
	principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer;
	capacityReceipt: WorkflowVerifiedHostReceipt;
	pathProofReceipt: WorkflowVerifiedHostReceipt;
	pathRelationProof: WorkConflictPathProofContext;
	workflowId: string;
	bindingDigest: string;
	stateDigest: string;
	revision: number;
	epochRef: WorkflowEpochRef;
	operationDigest: string;
}

/** One host proof for an explicitly declared path. */
export interface WorkConflictPathProof {
	declaredPath: string;
	workspaceRelativePath: string;
	canonicalPath: string;
	realPath: string;
	caseFoldedRealPath: string;
	symlinkResolved: true;
	caseResolved: true;
	proofDigest: string;
}

/** Path proof context whose receipt is authorized by the central host-principal seam. */
export interface WorkConflictPathProofContext {
	workspaceRoot: string;
	workspaceIdentity: string;
	proofDigest: string;
	proofs: readonly WorkConflictPathProof[];
}

/** A protected artifact/path scope that a task may not write. */
export interface WorkConflictProtectedScope {
	scopeId: string;
	artifacts?: readonly string[];
	paths?: readonly string[];
}

/** A ready task declaration used to construct the conflict graph. */
export interface WorkConflictTask {
	taskId: string;
	dependencies: readonly string[];
	readArtifacts: readonly string[];
	writeArtifacts: readonly string[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	role: WorkConflictRole;
	resourceRequest: WorkConflictResourceRequest;
	usefulness: number;
	workKey: string;
	lensKey?: string;
	lens?: string;
	reviewLens?: string;
	criticalPathLength?: number;
	criticalPath?: number;
	age?: number;
	ageMilliseconds?: number;
	fairness?: number;
	progress?: number;
	progressClaim?: unknown;
	completionClaim?: unknown;
}

/** The pure planner input. It carries no scheduler, lease, or store authority. */
export interface WorkConflictGraphInput {
	tasks?: readonly WorkConflictTask[];
	readyTasks?: readonly WorkConflictTask[];
	completedTaskIds?: readonly string[];
	authoritativeTaskIds: readonly string[];
	protectedScopes?: readonly WorkConflictProtectedScope[];
	authenticatedCapacity: WorkConflictAuthenticatedCapacity;
	activeTasks?: readonly WorkConflictTask[];
	pathProofContext: WorkConflictPathProofContext;
	hostAuthorization: WorkConflictHostAuthorization;
	progressClaims?: unknown;
	claimedProgress?: unknown;
	progress?: unknown;
}

/** Canonical declarations bound into a host-authorized dispatch operation digest. */
export interface WorkConflictOperationDigestInput {
	tasks: readonly WorkConflictTask[];
	activeTasks?: readonly WorkConflictTask[];
	completedTaskIds: readonly string[];
	authoritativeTaskIds: readonly string[];
	protectedScopes?: readonly WorkConflictProtectedScope[];
	authenticatedCapacity: WorkConflictAuthenticatedCapacity;
	pathProofContext: WorkConflictPathProofContext;
}

/** Reasons why a task was not admitted in this dispatch wave. */
export type WorkConflictBlockReason =
	| "dependency_wait"
	| "protected_scope"
	| "not_useful"
	| "active_conflict"
	| "conflict"
	| "duplicate_work"
	| "resource_capacity"
	| "packing_not_selected";

/** Reasons attached to one deterministic graph edge. */
export type WorkConflictEdgeReason = "write_write" | "read_write" | "duplicate_work";

/** A canonical graph node projection. */
export interface WorkConflictGraphNode {
	taskId: string;
	role: WorkConflictRole;
	workKey: string;
	lensKey: string;
	readArtifacts: readonly string[];
	writeArtifacts: readonly string[];
	readPaths: readonly string[];
	writePaths: readonly string[];
}

/** An undirected conflict edge with canonical endpoint ordering. */
export interface WorkConflictGraphEdge {
	leftTaskId: string;
	rightTaskId: string;
	reasons: readonly WorkConflictEdgeReason[];
}

/** The bounded, canonical conflict graph for the ready task set. */
export interface WorkConflictGraph {
	nodes: readonly WorkConflictGraphNode[];
	edges: readonly WorkConflictGraphEdge[];
}

/** A blocked task and all reasons that apply at the host observation. */
export interface WorkConflictBlockedTask {
	taskId: string;
	reasons: readonly WorkConflictBlockReason[];
	conflictsWith: readonly string[];
}

/** Objective totals used to document a bounded packing decision. */
export interface WorkConflictPackingObjective {
	criticalPathLength: number;
	age: number;
	fairness: number;
	usefulness: number;
}

/** Evidence describing whether packing is exact or bounded approximate. */
export interface WorkConflictPackingCertificate {
	status: "exact" | "bounded_approximation";
	method: "none" | "scalar_dynamic_program" | "branch_and_bound" | "beam_search";
	branchBudget: number;
	branchesExplored: number;
	objective: WorkConflictPackingObjective;
	upperBound: WorkConflictPackingObjective | null;
}

/** Result of selecting a maximal useful nonconflicting dispatch set. */
export interface WorkConflictDispatchPlan {
	selectedTaskIds: readonly string[];
	blockedTasks: readonly WorkConflictBlockedTask[];
	idleCapacity: WorkConflictResourceRequest;
	graph: WorkConflictGraph;
	packingCertificate: WorkConflictPackingCertificate;
}

export type WorkflowWorkConflictTask = WorkConflictTask;
export type WorkflowWorkConflictGraphInput = WorkConflictGraphInput;
export type WorkflowWorkConflictDispatchPlan = WorkConflictDispatchPlan;

const RESOURCE_DIMENSIONS: readonly WorkConflictResourceDimension[] = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
];

const CONTROL_DIMENSIONS: readonly WorkConflictControlDimension[] = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
];

const ROLE_RANK: Readonly<Record<WorkConflictRole, number>> = {
	writer: 4,
	test_oracle: 3,
	red_team: 2,
	ops_monitor: 1,
};

const BLOCK_REASON_ORDER: readonly WorkConflictBlockReason[] = [
	"dependency_wait",
	"protected_scope",
	"not_useful",
	"active_conflict",
	"conflict",
	"duplicate_work",
	"resource_capacity",
	"packing_not_selected",
];

const EDGE_REASON_ORDER: readonly WorkConflictEdgeReason[] = ["write_write", "read_write", "duplicate_work"];
const MAX_DECLARATIONS = 256;
const MAX_EXACT_CANDIDATES = 24;
const MAX_PACKING_BRANCHES = 100_000;
const MAX_BEAM_STATES = 256;
const MAX_SCALAR_DP_CELLS = 200_000;
const GLOB_SYNTAX = /[*?[\]{}()!^$]/u;
const PROVIDER_IDEMPOTENCY = new Set(["provider_native", "host_reconciled", "none"]);
const PROVIDER_IDEMPOTENCY_RANK: Readonly<Record<WorkConflictProviderRequest["idempotency"], number>> = {
	none: 0,
	host_reconciled: 1,
	provider_native: 2,
};
const READ_ONLY_ROLES = new Set<WorkConflictRole>(["test_oracle", "red_team", "ops_monitor"]);

type NormalizedTask = WorkConflictTask & {
	readonly dependencies: readonly string[];
	readonly readArtifacts: readonly string[];
	readonly writeArtifacts: readonly string[];
	readonly readPaths: readonly string[];
	readonly writePaths: readonly string[];
	readonly resourceRequest: WorkConflictResourceRequest;
	readonly lensKey: string;
	readonly criticalPathLength: number;
	readonly age: number;
	readonly fairness: number;
	readonly readPathIdentities: readonly string[];
	readonly writePathIdentities: readonly string[];
};

type NormalizedScope = {
	readonly scopeId: string;
	readonly artifacts: readonly string[];
	readonly paths: readonly string[];
	readonly pathIdentities: readonly string[];
};

type Score = {
	criticalPathLength: number;
	age: number;
	fairness: number;
	usefulness: number;
	ids: readonly string[];
};

type WorkConflictPathAuthorizationInput = WorkflowHostPrincipalCapabilityAuthorizationInput & {
	readonly pathRelationProof: WorkConflictPathProofContext;
};

function compareCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftCodePoints[index] !== rightCodePoints[index]) return leftCodePoints[index] - rightCodePoints[index];
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function compareTaskIds(left: { taskId: string }, right: { taskId: string }): number {
	return compareCodePointStrings(left.taskId, right.taskId);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
}

function assertClosedRecord(
	value: unknown,
	label: string,
	keys: readonly string[],
): asserts value is Record<string, unknown> {
	assertRecord(value, label);
	const allowed = new Set(keys);
	const actual = Object.getOwnPropertyNames(value);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error(`${label} must be a plain closed-schema record.`);
	if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} has an invalid closed-schema symbol.`);
	if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key)))
		throw new Error(`${label} has an invalid closed-schema shape.`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		keys.some(
			(key) =>
				descriptors[key]?.enumerable !== true ||
				descriptors[key]?.get !== undefined ||
				descriptors[key]?.set !== undefined,
		)
	)
		throw new Error(`${label} has an invalid closed-schema descriptor.`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
}

function assertFiniteNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a finite non-negative safe integer.`);
}

function assertFiniteNonNegativeScore(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error(`${label} must be finite and non-negative within safe score bounds.`);
}

function assertGlobFree(value: string, label: string): void {
	if (value.includes("\0")) throw new Error(`${label} must not contain control characters.`);
	if (GLOB_SYNTAX.test(value)) throw new Error(`${label} must not contain glob or wildcard syntax.`);
}

function assertExplicitArtifact(value: string, label: string): void {
	if (value.trim().length === 0 || value.normalize("NFC") !== value)
		throw new Error(`${label} must be an explicit canonical artifact identifier.`);
	assertGlobFree(value, label);
}

function assertPathSyntax(value: string, label: string, absoluteAllowed: boolean): void {
	if (
		value.length === 0 ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.normalize("NFC") !== value ||
		GLOB_SYNTAX.test(value) ||
		(!absoluteAllowed && (value.startsWith("/") || /^[A-Za-z]:/u.test(value))) ||
		(absoluteAllowed && !value.startsWith("/") && !/^[A-Za-z]:\//u.test(value)) ||
		value
			.split("/")
			.slice(value.startsWith("/") ? 1 : 0)
			.some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new Error(`${label} must be an explicit canonical path without wildcard or unscoped components.`);
	}
}

function canonicalStrings(values: readonly string[], label: string, path: boolean): readonly string[] {
	if (!Array.isArray(values)) throw new Error(`${label} must be a finite array.`);
	const unique = new Set<string>();
	for (const value of values) {
		assertNonEmptyString(value, `${label} member`);
		if (path) assertPathSyntax(value, `${label} member`, false);
		else assertExplicitArtifact(value, `${label} member`);
		unique.add(value);
	}
	return Object.freeze([...unique].sort(compareCodePointStrings));
}

function canonicalTaskIds(values: readonly string[], label: string): readonly string[] {
	if (!Array.isArray(values)) throw new Error(`${label} must be a finite array.`);
	const unique = new Set<string>();
	for (const value of values) {
		assertNonEmptyString(value, `${label} member`);
		assertGlobFree(value, `${label} member`);
		unique.add(value);
	}
	return Object.freeze([...unique].sort(compareCodePointStrings));
}

function assertResourceVector(value: unknown, label: string): WorkConflictResourceVector {
	assertClosedRecord(value, label, RESOURCE_DIMENSIONS);
	const result = {} as Record<WorkConflictResourceDimension, number>;
	for (const dimension of RESOURCE_DIMENSIONS) {
		assertFiniteNonNegativeInteger(value[dimension], `${label} ${dimension}`);
		result[dimension] = value[dimension] as number;
	}
	return Object.freeze(result) as WorkConflictResourceVector;
}

function assertControlVector(value: unknown, label: string): WorkConflictControlVector {
	assertClosedRecord(value, label, CONTROL_DIMENSIONS);
	const result = {} as Record<WorkConflictControlDimension, number>;
	for (const dimension of CONTROL_DIMENSIONS) {
		assertFiniteNonNegativeInteger(value[dimension], `${label} ${dimension}`);
		result[dimension] = value[dimension] as number;
	}
	return Object.freeze(result) as WorkConflictControlVector;
}

function addVectors<T extends string>(
	left: Readonly<Record<T, number>>,
	right: Readonly<Record<T, number>>,
	dimensions: readonly T[],
	label: string,
): Readonly<Record<T, number>> {
	const result = {} as Record<T, number>;
	for (const dimension of dimensions) {
		const sum = left[dimension] + right[dimension];
		if (!Number.isSafeInteger(sum)) throw new Error(`${label} ${dimension} exceeds safe capacity accounting.`);
		result[dimension] = sum;
	}
	return Object.freeze(result);
}

function subtractVectors<T extends string>(
	capacity: Readonly<Record<T, number>>,
	used: Readonly<Record<T, number>>,
	dimensions: readonly T[],
	label: string,
): Readonly<Record<T, number>> {
	const result = {} as Record<T, number>;
	for (const dimension of dimensions) {
		const difference = capacity[dimension] - used[dimension];
		if (difference < 0) throw new Error(`${label} is oversubscribed on ${dimension}.`);
		result[dimension] = difference;
	}
	return Object.freeze(result);
}

function fitsVectors<T extends string>(
	request: Readonly<Record<T, number>>,
	available: Readonly<Record<T, number>>,
	dimensions: readonly T[],
): boolean {
	return dimensions.every((dimension) => request[dimension] <= available[dimension]);
}

function emptyVector<T extends string>(dimensions: readonly T[]): Readonly<Record<T, number>> {
	const result = {} as Record<T, number>;
	for (const dimension of dimensions) result[dimension] = 0;
	return Object.freeze(result);
}

function normalizePools<T extends { poolId: string }>(
	value: unknown,
	label: string,
	keys: readonly string[],
	validate: (record: Record<string, unknown>, itemLabel: string) => T,
): readonly T[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be a finite array.`);
	const seen = new Set<string>();
	const normalized: T[] = [];
	for (const [index, item] of value.entries()) {
		const record = item as unknown;
		assertClosedRecord(record, `${label} ${index}`, keys);
		const pool = validate(record, `${label} ${index}`);
		if (seen.has(pool.poolId)) throw new Error(`${label} contains duplicate pool ${pool.poolId}.`);
		seen.add(pool.poolId);
		normalized.push(Object.freeze(pool));
	}
	return Object.freeze(normalized.sort((left, right) => compareCodePointStrings(left.poolId, right.poolId)));
}

function normalizeAcceleratorRequest(value: unknown, label: string): WorkConflictAcceleratorRequest {
	assertClosedRecord(value, label, ["poolId", "quantity", "memoryBytes"]);
	assertNonEmptyString(value.poolId, `${label} poolId`);
	assertGlobFree(value.poolId, `${label} poolId`);
	assertFiniteNonNegativeInteger(value.quantity, `${label} quantity`);
	assertFiniteNonNegativeInteger(value.memoryBytes, `${label} memoryBytes`);
	return { poolId: value.poolId, quantity: value.quantity, memoryBytes: value.memoryBytes };
}

function normalizeProviderRequest(value: unknown, label: string): WorkConflictProviderRequest {
	assertClosedRecord(value, label, [
		"poolId",
		"concurrentRequests",
		"requestsPerMinute",
		"totalRequests",
		"inputTokens",
		"outputTokens",
		"idempotency",
	]);
	assertNonEmptyString(value.poolId, `${label} poolId`);
	assertGlobFree(value.poolId, `${label} poolId`);
	for (const key of [
		"concurrentRequests",
		"requestsPerMinute",
		"totalRequests",
		"inputTokens",
		"outputTokens",
	] as const)
		assertFiniteNonNegativeInteger(value[key], `${label} ${key}`);
	if (typeof value.idempotency !== "string" || !PROVIDER_IDEMPOTENCY.has(value.idempotency))
		throw new Error(`${label} idempotency mode is invalid.`);
	return {
		poolId: value.poolId,
		concurrentRequests: value.concurrentRequests as number,
		requestsPerMinute: value.requestsPerMinute as number,
		totalRequests: value.totalRequests as number,
		inputTokens: value.inputTokens as number,
		outputTokens: value.outputTokens as number,
		idempotency: value.idempotency as WorkConflictProviderRequest["idempotency"],
	};
}

function normalizeResourceRequest(value: unknown, label: string): WorkConflictResourceRequest {
	assertClosedRecord(value, label, ["resources", "acceleratorPools", "providerPools", "controlCapacity"]);
	const resources = assertResourceVector(value.resources, `${label} resources`);
	const controlCapacity = assertControlVector(value.controlCapacity, `${label} controlCapacity`);
	const acceleratorPools = normalizePools(
		value.acceleratorPools,
		`${label} acceleratorPools`,
		["poolId", "quantity", "memoryBytes"],
		normalizeAcceleratorRequest,
	);
	const providerPools = normalizePools(
		value.providerPools,
		`${label} providerPools`,
		[
			"poolId",
			"concurrentRequests",
			"requestsPerMinute",
			"totalRequests",
			"inputTokens",
			"outputTokens",
			"idempotency",
		],
		normalizeProviderRequest,
	);
	return Object.freeze({ resources, acceleratorPools, providerPools, controlCapacity });
}

function capacityDigestPreimage(capacity: {
	schemaId: string;
	resources: WorkConflictResourceVector;
	acceleratorPools: readonly WorkConflictAcceleratorPool[];
	providerPools: readonly WorkConflictProviderPool[];
	controlCapacity: WorkConflictControlVector;
	protectedResourceReserve: WorkConflictResourceVector;
	protectedControlReserve: WorkConflictControlVector;
}): unknown {
	return {
		schemaId: capacity.schemaId,
		resources: capacity.resources,
		acceleratorPools: capacity.acceleratorPools,
		providerPools: capacity.providerPools,
		controlCapacity: capacity.controlCapacity,
		protectedResourceReserve: capacity.protectedResourceReserve,
		protectedControlReserve: capacity.protectedControlReserve,
	};
}

function normalizeCapacity(value: unknown): WorkConflictAuthenticatedCapacity {
	assertClosedRecord(value, "authenticated capacity", [
		"schemaId",
		"resources",
		"acceleratorPools",
		"providerPools",
		"controlCapacity",
		"protectedResourceReserve",
		"protectedControlReserve",
		"snapshotDigest",
	]);
	if (value.schemaId !== "work-conflict-capacity-v1") throw new Error("authenticated capacity schema is invalid.");
	const resources = assertResourceVector(value.resources, "authenticated capacity resources");
	const protectedResourceReserve = assertResourceVector(
		value.protectedResourceReserve,
		"authenticated capacity protectedResourceReserve",
	);
	const controlCapacity = assertControlVector(value.controlCapacity, "authenticated capacity controlCapacity");
	const protectedControlReserve = assertControlVector(
		value.protectedControlReserve,
		"authenticated capacity protectedControlReserve",
	);
	if (!fitsVectors(protectedResourceReserve, resources, RESOURCE_DIMENSIONS))
		throw new Error("protected resource reserve exceeds authenticated scalar capacity.");
	if (!fitsVectors(protectedControlReserve, controlCapacity, CONTROL_DIMENSIONS))
		throw new Error("protected control reserve exceeds authenticated control capacity.");
	const acceleratorPools = normalizePools(
		value.acceleratorPools,
		"authenticated capacity acceleratorPools",
		["poolId", "quantity", "memoryBytes"],
		normalizeAcceleratorRequest,
	) as readonly WorkConflictAcceleratorPool[];
	const providerPools = normalizePools(
		value.providerPools,
		"authenticated capacity providerPools",
		[
			"poolId",
			"concurrentRequests",
			"requestsPerMinute",
			"totalRequests",
			"inputTokens",
			"outputTokens",
			"idempotency",
		],
		normalizeProviderRequest,
	) as readonly WorkConflictProviderPool[];
	assertNonEmptyString(value.snapshotDigest, "authenticated capacity snapshotDigest");
	const normalized = Object.freeze({
		schemaId: value.schemaId as "work-conflict-capacity-v1",
		resources,
		acceleratorPools,
		providerPools,
		controlCapacity,
		protectedResourceReserve,
		protectedControlReserve,
		snapshotDigest: value.snapshotDigest,
	});
	const expectedDigest = digestObject(capacityDigestPreimage(normalized));
	if (normalized.snapshotDigest !== expectedDigest)
		throw new Error("authenticated capacity digest is not bound to its normalized snapshot.");
	return normalized;
}

function pathProofPreimage(proof: WorkConflictPathProof): Record<string, string | boolean> {
	return {
		declaredPath: proof.declaredPath,
		workspaceRelativePath: proof.workspaceRelativePath,
		canonicalPath: proof.canonicalPath,
		realPath: proof.realPath,
		caseFoldedRealPath: proof.caseFoldedRealPath,
		symlinkResolved: proof.symlinkResolved,
		caseResolved: proof.caseResolved,
	};
}

function pathProofContextDigest(
	workspaceRoot: string,
	workspaceIdentity: string,
	proofs: readonly WorkConflictPathProof[],
): string {
	return digestObject({
		workspaceRoot,
		workspaceIdentity,
		proofs: [...proofs]
			.sort((left, right) => compareCodePointStrings(left.declaredPath, right.declaredPath))
			.map((proof) => ({ ...pathProofPreimage(proof), proofDigest: proof.proofDigest })),
	});
}

function assertWorkspaceRoot(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	if (value !== "/") assertPathSyntax(value, label, true);
}

function pathWithinRoot(root: string, path: string): boolean {
	const foldedRoot = root.toLowerCase();
	const foldedPath = path.toLowerCase();
	return foldedRoot === "/"
		? foldedPath.startsWith("/")
		: foldedPath === foldedRoot || foldedPath.startsWith(`${foldedRoot}/`);
}

function joinWorkspacePath(root: string, relativePath: string): string {
	return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function normalizePathProofEvidence(value: unknown, label: string): WorkConflictPathProofContext {
	assertClosedRecord(value, label, ["workspaceRoot", "workspaceIdentity", "proofDigest", "proofs"]);
	assertWorkspaceRoot(value.workspaceRoot, `${label} workspaceRoot`);
	assertNonEmptyString(value.workspaceIdentity, `${label} workspaceIdentity`);
	assertGlobFree(value.workspaceIdentity, `${label} workspaceIdentity`);
	assertNonEmptyString(value.proofDigest, `${label} proofDigest`);
	if (!Array.isArray(value.proofs)) throw new Error(`${label} proofs must be a finite array.`);
	const proofs: WorkConflictPathProof[] = [];
	const byDeclaredPath = new Map<string, WorkConflictPathProof>();
	for (const [index, proofValue] of value.proofs.entries()) {
		assertClosedRecord(proofValue, `${label} proof ${index}`, [
			"declaredPath",
			"workspaceRelativePath",
			"canonicalPath",
			"realPath",
			"caseFoldedRealPath",
			"symlinkResolved",
			"caseResolved",
			"proofDigest",
		]);
		assertNonEmptyString(proofValue.declaredPath, `${label} proof ${index} declaredPath`);
		assertPathSyntax(proofValue.declaredPath, `${label} proof ${index} declaredPath`, false);
		assertNonEmptyString(proofValue.workspaceRelativePath, `${label} proof ${index} workspaceRelativePath`);
		assertPathSyntax(proofValue.workspaceRelativePath, `${label} proof ${index} workspaceRelativePath`, false);
		assertNonEmptyString(proofValue.canonicalPath, `${label} proof ${index} canonicalPath`);
		assertPathSyntax(
			proofValue.canonicalPath,
			`${label} proof ${index} canonicalPath`,
			proofValue.canonicalPath.startsWith("/") || /^[A-Za-z]:\//u.test(proofValue.canonicalPath),
		);
		assertNonEmptyString(proofValue.realPath, `${label} proof ${index} realPath`);
		assertPathSyntax(proofValue.realPath, `${label} proof ${index} realPath`, true);
		assertNonEmptyString(proofValue.caseFoldedRealPath, `${label} proof ${index} caseFoldedRealPath`);
		assertPathSyntax(proofValue.caseFoldedRealPath, `${label} proof ${index} caseFoldedRealPath`, true);
		if (proofValue.caseFoldedRealPath !== proofValue.realPath.toLowerCase())
			throw new Error(`${label} proof ${index} case-folded real path is not host-derived.`);
		if (proofValue.symlinkResolved !== true || proofValue.caseResolved !== true)
			throw new Error(`${label} proof ${index} must prove symlink and case resolution.`);
		assertNonEmptyString(proofValue.proofDigest, `${label} proof ${index} proofDigest`);
		const proof = Object.freeze({
			declaredPath: proofValue.declaredPath,
			workspaceRelativePath: proofValue.workspaceRelativePath,
			canonicalPath: proofValue.canonicalPath,
			realPath: proofValue.realPath,
			caseFoldedRealPath: proofValue.caseFoldedRealPath,
			symlinkResolved: true as const,
			caseResolved: true as const,
			proofDigest: proofValue.proofDigest,
		});
		if (proof.canonicalPath !== joinWorkspacePath(value.workspaceRoot as string, proof.workspaceRelativePath))
			throw new Error(`${label} proof ${index} canonical path is not rooted at the authenticated workspace.`);
		if (
			!pathWithinRoot(value.workspaceRoot as string, proof.canonicalPath) ||
			!pathWithinRoot(value.workspaceRoot as string, proof.realPath)
		)
			throw new Error(`${label} proof ${index} real path escapes the authenticated workspace root.`);
		if (proof.proofDigest !== digestObject(pathProofPreimage(proof)))
			throw new Error(`${label} proof ${index} digest does not match its host-resolved proof.`);
		if (byDeclaredPath.has(proof.declaredPath)) throw new Error(`duplicate path proof ${proof.declaredPath}.`);
		byDeclaredPath.set(proof.declaredPath, proof);
		proofs.push(proof);
	}
	const normalized = Object.freeze({
		workspaceRoot: value.workspaceRoot as string,
		workspaceIdentity: value.workspaceIdentity as string,
		proofDigest: value.proofDigest as string,
		proofs: Object.freeze(proofs),
	});
	if (
		pathProofContextDigest(normalized.workspaceRoot, normalized.workspaceIdentity, normalized.proofs) !==
		normalized.proofDigest
	)
		throw new Error(`${label} digest is not bound to the supplied path relation proofs.`);
	return normalized;
}

function normalizePathProofContext(
	value: unknown,
	declaredPaths: readonly string[],
): WorkConflictPathProofContext & { identities: ReadonlyMap<string, string> } {
	const normalized = normalizePathProofEvidence(value, "path proof context");
	const expectedPaths = [...new Set(declaredPaths)].sort(compareCodePointStrings);
	const byDeclaredPath = new Map(normalized.proofs.map((proof) => [proof.declaredPath, proof]));
	if (normalized.proofs.length !== expectedPaths.length || expectedPaths.some((path) => !byDeclaredPath.has(path)))
		throw new Error("path proof context must cover every declared path exactly once.");
	const identities = new Map<string, string>();
	for (const path of expectedPaths) identities.set(path, byDeclaredPath.get(path)?.caseFoldedRealPath ?? "");
	return { ...normalized, identities };
}

function samePathRelationProof(left: WorkConflictPathProofContext, right: WorkConflictPathProofContext): boolean {
	if (
		left.workspaceRoot !== right.workspaceRoot ||
		left.workspaceIdentity !== right.workspaceIdentity ||
		left.proofDigest !== right.proofDigest ||
		left.proofs.length !== right.proofs.length
	)
		return false;
	const rightByDeclaredPath = new Map(right.proofs.map((proof) => [proof.declaredPath, proof]));
	return left.proofs.every((proof) => {
		const counterpart = rightByDeclaredPath.get(proof.declaredPath);
		return counterpart !== undefined && JSON.stringify(proof) === JSON.stringify(counterpart);
	});
}

function assertEpochRef(value: unknown, label: string): asserts value is WorkflowEpochRef {
	assertClosedRecord(value, label, ["storeEpoch", "coordinatorEpoch"]);
	assertFiniteNonNegativeInteger(value.storeEpoch, `${label} storeEpoch`);
	assertFiniteNonNegativeInteger(value.coordinatorEpoch, `${label} coordinatorEpoch`);
}

function normalizeReceipt(value: unknown, label: string): WorkflowVerifiedHostReceipt {
	assertRecord(value, label);
	if (value.receiptKind !== "capability") throw new Error(`${label} must be a capability receipt.`);
	assertNonEmptyString(value.workflowId, `${label} workflowId`);
	assertNonEmptyString(value.payloadDigest, `${label} payloadDigest`);
	assertNonEmptyString(value.bindingDigest, `${label} bindingDigest`);
	assertRecord(value.artifactRef, `${label} artifactRef`);
	const capabilityBinding = value.capabilityBinding;
	if (capabilityBinding !== undefined) assertRecord(capabilityBinding, `${label} capabilityBinding`);
	return Object.freeze({
		...value,
		artifactRef: Object.freeze({ ...value.artifactRef }),
		...(capabilityBinding === undefined ? {} : { capabilityBinding: Object.freeze({ ...capabilityBinding }) }),
	}) as unknown as WorkflowVerifiedHostReceipt;
}

function normalizeHostAuthorization(value: unknown): WorkConflictHostAuthorization {
	assertClosedRecord(value, "host authorization", [
		"principalAuthorizer",
		"capacityReceipt",
		"pathProofReceipt",
		"pathRelationProof",
		"workflowId",
		"bindingDigest",
		"stateDigest",
		"revision",
		"epochRef",
		"operationDigest",
	]);
	const principalAuthorizer = value.principalAuthorizer;
	if (
		typeof principalAuthorizer !== "object" ||
		principalAuthorizer === null ||
		Array.isArray(principalAuthorizer) ||
		typeof (principalAuthorizer as Record<string, unknown>).authorize !== "function"
	)
		throw new Error("CONTRACT_CHANGE: host authorization requires the central principalAuthorizer seam.");
	for (const key of ["workflowId", "bindingDigest", "stateDigest", "operationDigest"] as const) {
		assertNonEmptyString(value[key], `host authorization ${key}`);
		assertGlobFree(value[key] as string, `host authorization ${key}`);
	}
	assertFiniteNonNegativeInteger(value.revision, "host authorization revision");
	assertEpochRef(value.epochRef, "host authorization epochRef");
	const capacityReceipt = normalizeReceipt(value.capacityReceipt, "host authorization capacityReceipt");
	const pathProofReceipt = normalizeReceipt(value.pathProofReceipt, "host authorization pathProofReceipt");
	const pathRelationProof = normalizePathProofEvidence(
		value.pathRelationProof,
		"host authorization pathRelationProof",
	);
	for (const [receipt, label] of [
		[capacityReceipt, "host authorization capacityReceipt"],
		[pathProofReceipt, "host authorization pathProofReceipt"],
	] as const) {
		assertRecord(receipt, label);
	}
	if (
		capacityReceipt.workflowId !== value.workflowId ||
		pathProofReceipt.workflowId !== value.workflowId ||
		capacityReceipt.bindingDigest !== value.bindingDigest ||
		pathProofReceipt.bindingDigest !== value.bindingDigest ||
		capacityReceipt.stateDigest !== value.stateDigest ||
		pathProofReceipt.stateDigest !== value.stateDigest ||
		capacityReceipt.revision !== value.revision ||
		pathProofReceipt.revision !== value.revision
	)
		throw new Error("host dispatch receipts are not bound to the current workflow, host state, and revision.");
	return Object.freeze({
		principalAuthorizer: principalAuthorizer as unknown as WorkflowHostPrincipalCapabilityAuthorizer,
		capacityReceipt,
		pathProofReceipt,
		pathRelationProof,
		workflowId: value.workflowId as string,
		bindingDigest: value.bindingDigest as string,
		stateDigest: value.stateDigest as string,
		revision: value.revision as number,
		epochRef: Object.freeze({
			storeEpoch: value.epochRef.storeEpoch as number,
			coordinatorEpoch: value.epochRef.coordinatorEpoch as number,
		}),
		operationDigest: value.operationDigest as string,
	});
}

function assertAuthorizationDecision(
	value: WorkflowHostPrincipalCapabilityAuthorization,
	receipt: WorkflowVerifiedHostReceipt,
	authorization: WorkConflictHostAuthorization,
	capability: WorkflowHostReceiptCapability,
	resourceDigest: string,
): WorkflowHostPrincipalCapabilityAuthorization {
	assertRecord(value, "host principal authorization result");
	if (
		value.capability !== capability ||
		value.workflowId !== authorization.workflowId ||
		value.bindingDigest !== authorization.bindingDigest ||
		value.stateDigest !== authorization.stateDigest ||
		value.revision !== authorization.revision ||
		value.epochRef.storeEpoch !== authorization.epochRef.storeEpoch ||
		value.epochRef.coordinatorEpoch !== authorization.epochRef.coordinatorEpoch ||
		value.receipt.receiptId !== receipt.receiptId ||
		value.receipt.payloadDigest !== resourceDigest
	)
		throw new Error("central host principal authorization is not bound to the current dispatch evidence.");
	assertNonEmptyString(value.authenticatedPrincipal, "host principal authorization authenticatedPrincipal");
	assertNonEmptyString(value.keyOwnerPrincipal, "host principal authorization keyOwnerPrincipal");
	return value;
}

async function authorizeDispatchEvidence(
	authorization: WorkConflictHostAuthorization,
	receipt: WorkflowVerifiedHostReceipt,
	capability: WorkflowHostReceiptCapability,
	resourceDigest: string,
): Promise<WorkflowHostPrincipalCapabilityAuthorization> {
	const request: WorkConflictPathAuthorizationInput = {
		receipt,
		workflowId: authorization.workflowId,
		bindingDigest: authorization.bindingDigest,
		resourceDigest,
		operationDigest: authorization.operationDigest,
		stateDigest: authorization.stateDigest,
		revision: authorization.revision,
		epochRef: authorization.epochRef,
		capability,
		pathRelationProof: authorization.pathRelationProof,
	};
	const pending = authorization.principalAuthorizer.authorize(request);
	if (pending === undefined || typeof pending.then !== "function")
		throw new Error("central host principal authorizer must complete asynchronously.");
	return assertAuthorizationDecision(await pending, receipt, authorization, capability, resourceDigest);
}

function isZeroResourceRequest(request: WorkConflictResourceRequest): boolean {
	return (
		RESOURCE_DIMENSIONS.every((dimension) => request.resources[dimension] === 0) &&
		CONTROL_DIMENSIONS.every((dimension) => request.controlCapacity[dimension] === 0) &&
		request.acceleratorPools.every((pool) => pool.quantity === 0 && pool.memoryBytes === 0) &&
		request.providerPools.every(
			(pool) =>
				pool.concurrentRequests === 0 &&
				pool.requestsPerMinute === 0 &&
				pool.totalRequests === 0 &&
				pool.inputTokens === 0 &&
				pool.outputTokens === 0,
		)
	);
}

function normalizeTask(
	task: WorkConflictTask,
	label: string,
): Omit<NormalizedTask, "readPathIdentities" | "writePathIdentities"> {
	assertRecord(task, label);
	assertNonEmptyString(task.taskId, `${label} taskId`);
	assertGlobFree(task.taskId, `${label} taskId`);
	if (typeof task.role !== "string" || !Object.hasOwn(ROLE_RANK, task.role))
		throw new Error(`${label} role is invalid.`);
	assertNonEmptyString(task.workKey, `${label} workKey`);
	assertGlobFree(task.workKey, `${label} workKey`);
	assertFiniteNonNegativeScore(task.usefulness, `${label} usefulness`);
	const dependencies = canonicalTaskIds(task.dependencies, `${label} dependencies`);
	if (dependencies.includes(task.taskId)) throw new Error(`${label} cannot depend on itself.`);
	const readArtifacts = canonicalStrings(task.readArtifacts, `${label} readArtifacts`, false);
	const writeArtifacts = canonicalStrings(task.writeArtifacts, `${label} writeArtifacts`, false);
	const readPaths = canonicalStrings(task.readPaths, `${label} readPaths`, true);
	const writePaths = canonicalStrings(task.writePaths, `${label} writePaths`, true);
	if (
		Object.hasOwn(task, "progress") ||
		Object.hasOwn(task, "progressClaim") ||
		Object.hasOwn(task, "completionClaim")
	)
		throw new Error(`${label} contains an unauthenticated caller progress claim.`);
	if (READ_ONLY_ROLES.has(task.role) && (writeArtifacts.length > 0 || writePaths.length > 0))
		throw new Error(`${label} read-only role cannot declare write scope.`);
	if (task.role === "writer" && writeArtifacts.length === 0 && writePaths.length === 0)
		throw new Error(`${label} writer must declare an explicit write scope.`);
	const resourceRequest = normalizeResourceRequest(task.resourceRequest, `${label} resourceRequest`);
	if (readArtifacts.length === 0 && writeArtifacts.length === 0 && readPaths.length === 0 && writePaths.length === 0)
		throw new Error(`${label} declares an empty scope and is a no-op.`);
	if (isZeroResourceRequest(resourceRequest)) throw new Error(`${label} declares zero resources and is a no-op.`);
	const lensKey = task.lensKey ?? task.lens ?? task.reviewLens ?? task.role;
	assertNonEmptyString(lensKey, `${label} lensKey`);
	assertGlobFree(lensKey, `${label} lensKey`);
	const criticalPathLength = task.criticalPathLength ?? task.criticalPath ?? 0;
	const age = task.age ?? task.ageMilliseconds ?? 0;
	const fairness = task.fairness ?? 0;
	for (const [value, name] of [
		[criticalPathLength, "criticalPathLength"],
		[age, "age"],
		[fairness, "fairness"],
	] as const) {
		assertFiniteNonNegativeScore(value, `${label} ${name}`);
	}
	return {
		...task,
		dependencies,
		readArtifacts,
		writeArtifacts,
		readPaths,
		writePaths,
		resourceRequest,
		lensKey,
		criticalPathLength,
		age,
		fairness,
	};
}

function normalizeScope(scope: WorkConflictProtectedScope, index: number): Omit<NormalizedScope, "pathIdentities"> {
	assertRecord(scope, `protected scope ${index}`);
	assertNonEmptyString(scope.scopeId, `protected scope ${index} scopeId`);
	assertGlobFree(scope.scopeId, `protected scope ${index} scopeId`);
	const artifacts = canonicalStrings(scope.artifacts ?? [], `protected scope ${scope.scopeId} artifacts`, false);
	const paths = canonicalStrings(scope.paths ?? [], `protected scope ${scope.scopeId} paths`, true);
	if (artifacts.length === 0 && paths.length === 0)
		throw new Error(`protected scope ${scope.scopeId} must declare an explicit artifact or path scope.`);
	return { scopeId: scope.scopeId, artifacts, paths };
}

function assertUniqueScopeIds(scopes: readonly { scopeId: string }[]): void {
	const seen = new Set<string>();
	for (const scope of scopes) {
		if (seen.has(scope.scopeId)) throw new Error(`duplicate protected scope ${scope.scopeId}.`);
		seen.add(scope.scopeId);
	}
}

function duplicateIdentity(task: Pick<NormalizedTask, "workKey" | "role" | "lensKey">): string {
	return `${task.workKey}\u0000${task.role}\u0000${task.lensKey}`;
}

function pathOverlaps(left: string, right: string): boolean {
	const leftParts = left.split("/");
	const rightParts = right.split("/");
	const isPrefix = (prefix: readonly string[], value: readonly string[]): boolean =>
		prefix.length <= value.length && prefix.every((part, index) => part === value[index]);
	return isPrefix(leftParts, rightParts) || isPrefix(rightParts, leftParts);
}

function exactOverlap(left: readonly string[], right: readonly string[]): boolean {
	const rightSet = new Set(right);
	return left.some((value) => rightSet.has(value));
}

function pathSetOverlap(left: readonly string[], right: readonly string[]): boolean {
	return left.some((leftPath) => right.some((rightPath) => pathOverlaps(leftPath, rightPath)));
}

function hasWriteWriteOverlap(left: NormalizedTask, right: NormalizedTask): boolean {
	return (
		exactOverlap(left.writeArtifacts, right.writeArtifacts) ||
		pathSetOverlap(left.writePathIdentities, right.writePathIdentities)
	);
}

function hasReadWriteOverlap(reader: NormalizedTask, writer: NormalizedTask): boolean {
	return (
		exactOverlap(reader.readArtifacts, writer.writeArtifacts) ||
		pathSetOverlap(reader.readPathIdentities, writer.writePathIdentities)
	);
}

function edgeReasons(left: NormalizedTask, right: NormalizedTask): readonly WorkConflictEdgeReason[] {
	const reasons: WorkConflictEdgeReason[] = [];
	if (hasWriteWriteOverlap(left, right)) reasons.push("write_write");
	if (hasReadWriteOverlap(left, right) || hasReadWriteOverlap(right, left)) reasons.push("read_write");
	if (duplicateIdentity(left) === duplicateIdentity(right)) reasons.push("duplicate_work");
	return Object.freeze(EDGE_REASON_ORDER.filter((reason) => reasons.includes(reason)));
}

function hasScopeOverlap(task: NormalizedTask, scope: NormalizedScope): boolean {
	return (
		exactOverlap(task.writeArtifacts, scope.artifacts) ||
		pathSetOverlap(task.writePathIdentities, scope.pathIdentities)
	);
}

function createGraph(tasks: readonly NormalizedTask[]): WorkConflictGraph {
	const sortedTasks = [...tasks].sort(compareTaskIds);
	const nodes = Object.freeze(
		sortedTasks.map((task) =>
			Object.freeze({
				taskId: task.taskId,
				role: task.role,
				workKey: task.workKey,
				lensKey: task.lensKey,
				readArtifacts: task.readArtifacts,
				writeArtifacts: task.writeArtifacts,
				readPaths: task.readPaths,
				writePaths: task.writePaths,
			}),
		),
	);
	const edges: WorkConflictGraphEdge[] = [];
	for (let leftIndex = 0; leftIndex < sortedTasks.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < sortedTasks.length; rightIndex += 1) {
			const left = sortedTasks[leftIndex];
			const right = sortedTasks[rightIndex];
			const reasons = edgeReasons(left, right);
			if (reasons.length > 0)
				edges.push(Object.freeze({ leftTaskId: left.taskId, rightTaskId: right.taskId, reasons }));
		}
	}
	return Object.freeze({ nodes, edges: Object.freeze(edges) });
}

function blockedTask(
	taskId: string,
	reasons: readonly WorkConflictBlockReason[],
	conflictsWith: readonly string[],
): WorkConflictBlockedTask {
	return Object.freeze({
		taskId,
		reasons: Object.freeze(BLOCK_REASON_ORDER.filter((reason) => reasons.includes(reason))),
		conflictsWith: Object.freeze([...new Set(conflictsWith)].sort(compareCodePointStrings)),
	});
}

function normalizeTaskPaths(
	task: Omit<NormalizedTask, "readPathIdentities" | "writePathIdentities">,
	proofIdentities: ReadonlyMap<string, string>,
): NormalizedTask {
	const pathIdentity = (path: string): string => {
		const identity = proofIdentities.get(path);
		if (identity === undefined) throw new Error(`missing host path proof for ${path}.`);
		return identity;
	};
	return Object.freeze({
		...task,
		readPathIdentities: Object.freeze(task.readPaths.map(pathIdentity)),
		writePathIdentities: Object.freeze(task.writePaths.map(pathIdentity)),
	});
}

function normalizeScopePaths(
	scope: Omit<NormalizedScope, "pathIdentities">,
	proofIdentities: ReadonlyMap<string, string>,
): NormalizedScope {
	const pathIdentity = (path: string): string => {
		const identity = proofIdentities.get(path);
		if (identity === undefined) throw new Error(`missing host path proof for protected scope ${path}.`);
		return identity;
	};
	return Object.freeze({ ...scope, pathIdentities: Object.freeze(scope.paths.map(pathIdentity)) });
}

function operationTaskProjection(task: NormalizedTask): unknown {
	return {
		taskId: task.taskId,
		dependencies: task.dependencies,
		readArtifacts: task.readArtifacts,
		writeArtifacts: task.writeArtifacts,
		readPaths: task.readPaths,
		writePaths: task.writePaths,
		readPathIdentities: task.readPathIdentities,
		writePathIdentities: task.writePathIdentities,
		role: task.role,
		workKey: task.workKey,
		lensKey: task.lensKey,
		usefulness: task.usefulness,
		criticalPathLength: task.criticalPathLength,
		age: task.age,
		fairness: task.fairness,
		resourceRequest: task.resourceRequest,
	};
}

function operationScopeProjection(scope: NormalizedScope): unknown {
	return {
		scopeId: scope.scopeId,
		artifacts: scope.artifacts,
		paths: scope.paths,
		pathIdentities: scope.pathIdentities,
	};
}

function operationDigestFromNormalized(input: {
	tasks: readonly NormalizedTask[];
	activeTasks: readonly NormalizedTask[];
	completedTaskIds: readonly string[];
	authoritativeTaskIds: readonly string[];
	protectedScopes: readonly NormalizedScope[];
	capacity: WorkConflictAuthenticatedCapacity;
	pathProofDigest: string;
}): string {
	return digestObject({
		schemaId: "work-conflict-operation-v1",
		tasks: [...input.tasks].sort(compareTaskIds).map(operationTaskProjection),
		activeTasks: [...input.activeTasks].sort(compareTaskIds).map(operationTaskProjection),
		completedTaskIds: [...input.completedTaskIds].sort(compareCodePointStrings),
		authoritativeTaskIds: [...input.authoritativeTaskIds].sort(compareCodePointStrings),
		protectedScopes: [...input.protectedScopes]
			.sort((left, right) => compareCodePointStrings(left.scopeId, right.scopeId))
			.map(operationScopeProjection),
		capacity: capacityDigestPreimage(input.capacity),
		pathProofDigest: input.pathProofDigest,
	});
}

/**
 * Compute the canonical digest that a host capability receipt must authorize.
 *
 * Args:
 * input: The complete ready/active graph declaration, reconciliation sets, protected scopes, capacity, and path proofs.
 * Return: Digest of the normalized dispatch operation, independent of declaration order.
 */
export function computeWorkConflictOperationDigest(input: WorkConflictOperationDigestInput): string {
	assertRecord(input, "work conflict operation digest input");
	if (!Array.isArray(input.tasks)) throw new Error("work conflict operation tasks must be a finite array.");
	const activeDeclarations = input.activeTasks ?? [];
	if (!Array.isArray(activeDeclarations))
		throw new Error("work conflict operation active tasks must be a finite array.");
	if (input.tasks.length + activeDeclarations.length > MAX_DECLARATIONS)
		throw new Error(`work conflict operation is bounded to ${MAX_DECLARATIONS} active and ready declarations.`);
	const completedTaskIds = canonicalTaskIds(input.completedTaskIds, "completed task IDs");
	const authoritativeTaskIds = canonicalTaskIds(input.authoritativeTaskIds, "authoritative task IDs");
	const capacity = normalizeCapacity(input.authenticatedCapacity);
	const protectedScopeDeclarations = input.protectedScopes ?? [];
	if (!Array.isArray(protectedScopeDeclarations))
		throw new Error("work conflict operation protected scopes must be a finite array.");
	const declaredPaths: string[] = [];
	const rawTasks = input.tasks.map((task, index) => {
		const normalized = normalizeTask(task, `task ${index}`);
		declaredPaths.push(...normalized.readPaths, ...normalized.writePaths);
		return normalized;
	});
	const rawActiveTasks = activeDeclarations.map((task, index) => {
		const normalized = normalizeTask(task, `active task ${index}`);
		declaredPaths.push(...normalized.readPaths, ...normalized.writePaths);
		return normalized;
	});
	const rawScopes = protectedScopeDeclarations.map(normalizeScope);
	assertUniqueScopeIds(rawScopes);
	for (const scope of rawScopes) declaredPaths.push(...scope.paths);
	const pathProofContext = normalizePathProofContext(input.pathProofContext, declaredPaths);
	const proofIdentities = pathProofContext.identities;
	const tasks = rawTasks.map((task) => normalizeTaskPaths(task, proofIdentities));
	const activeTasks = rawActiveTasks.map((task) => normalizeTaskPaths(task, proofIdentities));
	const protectedScopes = rawScopes.map((scope) => normalizeScopePaths(scope, proofIdentities));
	return operationDigestFromNormalized({
		tasks,
		activeTasks,
		completedTaskIds,
		authoritativeTaskIds,
		protectedScopes,
		capacity,
		pathProofDigest: pathProofContext.proofDigest,
	});
}

function addRequest(
	left: WorkConflictResourceRequest,
	right: WorkConflictResourceRequest,
	label: string,
): WorkConflictResourceRequest {
	const acceleratorByPool = new Map(left.acceleratorPools.map((pool) => [pool.poolId, pool]));
	for (const pool of right.acceleratorPools) {
		const existing = acceleratorByPool.get(pool.poolId);
		acceleratorByPool.set(pool.poolId, {
			poolId: pool.poolId,
			quantity: (existing?.quantity ?? 0) + pool.quantity,
			memoryBytes: (existing?.memoryBytes ?? 0) + pool.memoryBytes,
		});
	}
	const providerByPool = new Map(left.providerPools.map((pool) => [pool.poolId, pool]));
	for (const pool of right.providerPools) {
		const existing = providerByPool.get(pool.poolId);
		const idempotency =
			existing === undefined ||
			PROVIDER_IDEMPOTENCY_RANK[pool.idempotency] > PROVIDER_IDEMPOTENCY_RANK[existing.idempotency]
				? pool.idempotency
				: existing.idempotency;
		providerByPool.set(pool.poolId, {
			poolId: pool.poolId,
			concurrentRequests: (existing?.concurrentRequests ?? 0) + pool.concurrentRequests,
			requestsPerMinute: (existing?.requestsPerMinute ?? 0) + pool.requestsPerMinute,
			totalRequests: (existing?.totalRequests ?? 0) + pool.totalRequests,
			inputTokens: (existing?.inputTokens ?? 0) + pool.inputTokens,
			outputTokens: (existing?.outputTokens ?? 0) + pool.outputTokens,
			idempotency,
		});
	}
	return Object.freeze({
		resources: addVectors(left.resources, right.resources, RESOURCE_DIMENSIONS, label) as WorkConflictResourceVector,
		acceleratorPools: Object.freeze(
			[...acceleratorByPool.values()]
				.sort((a, b) => compareCodePointStrings(a.poolId, b.poolId))
				.map((pool) => Object.freeze(pool)),
		),
		providerPools: Object.freeze(
			[...providerByPool.values()]
				.sort((a, b) => compareCodePointStrings(a.poolId, b.poolId))
				.map((pool) => Object.freeze(pool)),
		),
		controlCapacity: addVectors(
			left.controlCapacity,
			right.controlCapacity,
			CONTROL_DIMENSIONS,
			label,
		) as WorkConflictControlVector,
	});
}

function fitsRequest(request: WorkConflictResourceRequest, available: WorkConflictResourceRequest): boolean {
	if (!fitsVectors(request.resources, available.resources, RESOURCE_DIMENSIONS)) return false;
	if (!fitsVectors(request.controlCapacity, available.controlCapacity, CONTROL_DIMENSIONS)) return false;
	const availableAccelerators = new Map(available.acceleratorPools.map((pool) => [pool.poolId, pool]));
	for (const pool of request.acceleratorPools) {
		const capacity = availableAccelerators.get(pool.poolId);
		if (capacity === undefined || pool.quantity > capacity.quantity || pool.memoryBytes > capacity.memoryBytes)
			return false;
	}
	const availableProviders = new Map(available.providerPools.map((pool) => [pool.poolId, pool]));
	for (const pool of request.providerPools) {
		const capacity = availableProviders.get(pool.poolId);
		if (
			capacity === undefined ||
			PROVIDER_IDEMPOTENCY_RANK[capacity.idempotency] < PROVIDER_IDEMPOTENCY_RANK[pool.idempotency] ||
			pool.concurrentRequests > capacity.concurrentRequests ||
			pool.requestsPerMinute > capacity.requestsPerMinute ||
			pool.totalRequests > capacity.totalRequests ||
			pool.inputTokens > capacity.inputTokens ||
			pool.outputTokens > capacity.outputTokens
		)
			return false;
	}
	return true;
}

function subtractRequest(
	capacity: WorkConflictResourceRequest,
	used: WorkConflictResourceRequest,
): WorkConflictResourceRequest {
	const usedAccelerators = new Map(used.acceleratorPools.map((pool) => [pool.poolId, pool]));
	const acceleratorPools = capacity.acceleratorPools.map((pool) => {
		const usage = usedAccelerators.get(pool.poolId);
		return Object.freeze({
			poolId: pool.poolId,
			quantity: pool.quantity - (usage?.quantity ?? 0),
			memoryBytes: pool.memoryBytes - (usage?.memoryBytes ?? 0),
		});
	});
	const usedProviders = new Map(used.providerPools.map((pool) => [pool.poolId, pool]));
	const providerPools = capacity.providerPools.map((pool) => {
		const usage = usedProviders.get(pool.poolId);
		return Object.freeze({
			poolId: pool.poolId,
			concurrentRequests: pool.concurrentRequests - (usage?.concurrentRequests ?? 0),
			requestsPerMinute: pool.requestsPerMinute - (usage?.requestsPerMinute ?? 0),
			totalRequests: pool.totalRequests - (usage?.totalRequests ?? 0),
			inputTokens: pool.inputTokens - (usage?.inputTokens ?? 0),
			outputTokens: pool.outputTokens - (usage?.outputTokens ?? 0),
			idempotency: pool.idempotency,
		});
	});
	return Object.freeze({
		resources: subtractVectors(
			capacity.resources,
			used.resources,
			RESOURCE_DIMENSIONS,
			"resource capacity",
		) as WorkConflictResourceVector,
		acceleratorPools: Object.freeze(acceleratorPools),
		providerPools: Object.freeze(providerPools),
		controlCapacity: subtractVectors(
			capacity.controlCapacity,
			used.controlCapacity,
			CONTROL_DIMENSIONS,
			"control capacity",
		) as WorkConflictControlVector,
	});
}

function emptyRequest(): WorkConflictResourceRequest {
	return Object.freeze({
		resources: emptyVector(RESOURCE_DIMENSIONS) as WorkConflictResourceVector,
		acceleratorPools: Object.freeze([]),
		providerPools: Object.freeze([]),
		controlCapacity: emptyVector(CONTROL_DIMENSIONS) as WorkConflictControlVector,
	});
}

function compareIds(left: readonly string[], right: readonly string[]): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const comparison = compareCodePointStrings(left[index], right[index]);
		if (comparison !== 0) return comparison;
	}
	return left.length - right.length;
}

function compareScores(left: Score, right: Score): number {
	for (const [leftValue, rightValue] of [
		[left.criticalPathLength, right.criticalPathLength],
		[left.age, right.age],
		[left.fairness, right.fairness],
		[left.usefulness, right.usefulness],
	] as const) {
		if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
	}
	return -compareIds(left.ids, right.ids);
}

function compareScoreValues(left: Score, right: Score): number {
	for (const [leftValue, rightValue] of [
		[left.criticalPathLength, right.criticalPathLength],
		[left.age, right.age],
		[left.fairness, right.fairness],
		[left.usefulness, right.usefulness],
	] as const) {
		if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
	}
	return 0;
}

function scoreFor(tasks: readonly NormalizedTask[]): Score {
	return {
		criticalPathLength: tasks.reduce((sum, task) => sum + task.criticalPathLength, 0),
		age: tasks.reduce((sum, task) => sum + task.age, 0),
		fairness: tasks.reduce((sum, task) => sum + task.fairness, 0),
		usefulness: tasks.reduce((sum, task) => sum + task.usefulness, 0),
		ids: tasks.map((task) => task.taskId).sort(compareCodePointStrings),
	};
}

function scoreWithTask(score: Score, task: NormalizedTask): Score {
	return {
		usefulness: score.usefulness + task.usefulness,
		criticalPathLength: score.criticalPathLength + task.criticalPathLength,
		age: score.age + task.age,
		fairness: score.fairness + task.fairness,
		ids: [...score.ids, task.taskId].sort(compareCodePointStrings),
	};
}

function scoreObjective(score: Score): WorkConflictPackingObjective {
	return {
		criticalPathLength: score.criticalPathLength,
		age: score.age,
		fairness: score.fairness,
		usefulness: score.usefulness,
	};
}

function packingCertificate(
	tasks: readonly NormalizedTask[],
	status: WorkConflictPackingCertificate["status"],
	method: WorkConflictPackingCertificate["method"],
	branchBudget: number,
	branchesExplored: number,
	upperBound: Score | null,
): WorkConflictPackingCertificate {
	return Object.freeze({
		status,
		method,
		branchBudget,
		branchesExplored,
		objective: Object.freeze(scoreObjective(scoreFor(tasks))),
		upperBound: upperBound === null ? null : Object.freeze(scoreObjective(upperBound)),
	});
}

type PackingSelection = {
	selectedIds: ReadonlySet<string>;
	certificate: WorkConflictPackingCertificate;
};

function scalarPackingDimension(
	candidates: readonly NormalizedTask[],
	conflicts: ReadonlyMap<string, ReadonlySet<string>>,
): WorkConflictResourceDimension | undefined {
	if ([...conflicts.values()].some((taskConflicts) => taskConflicts.size > 0)) return undefined;
	const dimensions = RESOURCE_DIMENSIONS.filter((dimension) =>
		candidates.some((task) => task.resourceRequest.resources[dimension] > 0),
	);
	if (dimensions.length !== 1) return undefined;
	const [dimension] = dimensions;
	for (const task of candidates) {
		if (
			CONTROL_DIMENSIONS.some((controlDimension) => task.resourceRequest.controlCapacity[controlDimension] > 0) ||
			task.resourceRequest.acceleratorPools.length > 0 ||
			task.resourceRequest.providerPools.length > 0 ||
			RESOURCE_DIMENSIONS.some(
				(resourceDimension) =>
					resourceDimension !== dimension && task.resourceRequest.resources[resourceDimension] > 0,
			)
		)
			return undefined;
	}
	return dimension;
}

function selectScalarPacking(
	candidates: readonly NormalizedTask[],
	available: WorkConflictResourceRequest,
	conflicts: ReadonlyMap<string, ReadonlySet<string>>,
): PackingSelection | undefined {
	const dimension = scalarPackingDimension(candidates, conflicts);
	if (dimension === undefined) return undefined;
	const capacity = available.resources[dimension];
	if ((capacity + 1) * candidates.length > MAX_SCALAR_DP_CELLS) return undefined;
	const ordered = [...candidates].sort(compareTaskIds);
	type Entry = { tasks: readonly NormalizedTask[]; score: Score };
	const dynamic = new Array<Entry | undefined>(capacity + 1);
	dynamic[0] = { tasks: [], score: scoreFor([]) };
	let branches = 0;
	for (const candidate of ordered) {
		const weight = candidate.resourceRequest.resources[dimension];
		if (weight <= 0 || weight > capacity) return undefined;
		for (let used = capacity - weight; used >= 0; used -= 1) {
			branches += 1;
			const entry = dynamic[used];
			if (entry === undefined) continue;
			const nextEntry: Entry = {
				tasks: [...entry.tasks, candidate],
				score: scoreWithTask(entry.score, candidate),
			};
			const nextUsed = used + weight;
			const existing = dynamic[nextUsed];
			if (existing === undefined || compareScores(nextEntry.score, existing.score) > 0)
				dynamic[nextUsed] = nextEntry;
		}
	}
	let best: Entry = dynamic[0] as Entry;
	for (const entry of dynamic) {
		if (entry !== undefined && compareScores(entry.score, best.score) > 0) best = entry;
	}
	return {
		selectedIds: new Set(best.tasks.map((task) => task.taskId)),
		certificate: packingCertificate(
			best.tasks,
			"exact",
			"scalar_dynamic_program",
			MAX_SCALAR_DP_CELLS,
			branches,
			null,
		),
	};
}

function selectExactPacking(
	candidates: readonly NormalizedTask[],
	available: WorkConflictResourceRequest,
	conflicts: ReadonlyMap<string, ReadonlySet<string>>,
): PackingSelection {
	const ordered = [...candidates].sort((left, right) => {
		const scoreComparison = compareScores(scoreFor([left]), scoreFor([right]));
		return scoreComparison === 0 ? compareTaskIds(left, right) : -scoreComparison;
	});
	const suffixCriticalPath = new Array<number>(ordered.length + 1).fill(0);
	const suffixAge = new Array<number>(ordered.length + 1).fill(0);
	const suffixFairness = new Array<number>(ordered.length + 1).fill(0);
	const suffixUsefulness = new Array<number>(ordered.length + 1).fill(0);
	for (let index = ordered.length - 1; index >= 0; index -= 1) {
		suffixCriticalPath[index] = suffixCriticalPath[index + 1] + ordered[index].criticalPathLength;
		suffixAge[index] = suffixAge[index + 1] + ordered[index].age;
		suffixFairness[index] = suffixFairness[index + 1] + ordered[index].fairness;
		suffixUsefulness[index] = suffixUsefulness[index + 1] + ordered[index].usefulness;
	}
	let bestTasks: readonly NormalizedTask[] = [];
	let bestScore = scoreFor(bestTasks);
	let branches = 0;
	let exhausted = false;
	const search = (
		index: number,
		chosen: readonly NormalizedTask[],
		chosenIds: ReadonlySet<string>,
		used: WorkConflictResourceRequest,
		score: Score,
	): void => {
		branches += 1;
		if (branches > MAX_PACKING_BRANCHES) {
			exhausted = true;
			return;
		}
		if (index === ordered.length) {
			if (compareScores(score, bestScore) > 0) {
				bestScore = score;
				bestTasks = chosen;
			}
			return;
		}
		const upperBound: Score = {
			criticalPathLength: score.criticalPathLength + suffixCriticalPath[index],
			age: score.age + suffixAge[index],
			fairness: score.fairness + suffixFairness[index],
			usefulness: score.usefulness + suffixUsefulness[index],
			ids: [],
		};
		if (compareScoreValues(upperBound, bestScore) < 0) return;
		const candidate = ordered[index];
		const candidateConflicts = conflicts.get(candidate.taskId) ?? new Set<string>();
		if (
			[...candidateConflicts].every((taskId) => !chosenIds.has(taskId)) &&
			fitsRequest(candidate.resourceRequest, subtractRequest(available, used))
		) {
			const nextChosen = [...chosen, candidate];
			const nextChosenIds = new Set(chosenIds);
			nextChosenIds.add(candidate.taskId);
			search(
				index + 1,
				nextChosen,
				nextChosenIds,
				addRequest(used, candidate.resourceRequest, "packing usage"),
				scoreWithTask(score, candidate),
			);
		}
		search(index + 1, chosen, chosenIds, used, score);
	};
	search(0, [], new Set<string>(), emptyRequest(), scoreFor([]));
	if (exhausted) return selectBeamPacking(candidates, available, conflicts);
	return {
		selectedIds: new Set(bestTasks.map((task) => task.taskId)),
		certificate: packingCertificate(
			bestTasks,
			"exact",
			"branch_and_bound",
			MAX_PACKING_BRANCHES,
			Math.min(branches, MAX_PACKING_BRANCHES),
			null,
		),
	};
}

type PackingState = {
	chosen: readonly NormalizedTask[];
	chosenIds: ReadonlySet<string>;
	used: WorkConflictResourceRequest;
	score: Score;
};

function comparePackingStates(left: PackingState, right: PackingState): number {
	const scoreComparison = compareScores(left.score, right.score);
	if (scoreComparison !== 0) return -scoreComparison;
	return compareIds(left.score.ids, right.score.ids);
}

function selectBeamPacking(
	candidates: readonly NormalizedTask[],
	available: WorkConflictResourceRequest,
	conflicts: ReadonlyMap<string, ReadonlySet<string>>,
): PackingSelection {
	const ordered = [...candidates].sort((left, right) => {
		const scoreComparison = compareScores(scoreFor([left]), scoreFor([right]));
		return scoreComparison === 0 ? compareTaskIds(left, right) : -scoreComparison;
	});
	let states: PackingState[] = [
		{
			chosen: [],
			chosenIds: new Set<string>(),
			used: emptyRequest(),
			score: scoreFor([]),
		},
	];
	let branches = 0;
	for (const candidate of ordered) {
		const nextStates = [...states];
		for (const state of states) {
			branches += 1;
			if (branches > MAX_PACKING_BRANCHES) break;
			const candidateConflicts = conflicts.get(candidate.taskId) ?? new Set<string>();
			if (
				[...candidateConflicts].every((taskId) => !state.chosenIds.has(taskId)) &&
				fitsRequest(candidate.resourceRequest, subtractRequest(available, state.used))
			) {
				const chosenIds = new Set(state.chosenIds);
				chosenIds.add(candidate.taskId);
				nextStates.push({
					chosen: [...state.chosen, candidate],
					chosenIds,
					used: addRequest(state.used, candidate.resourceRequest, "bounded packing usage"),
					score: {
						...scoreWithTask(state.score, candidate),
					},
				});
			}
		}
		states = nextStates.sort(comparePackingStates).slice(0, MAX_BEAM_STATES);
		if (branches > MAX_PACKING_BRANCHES) break;
	}
	let best = states[0];
	for (const state of states.slice(1)) {
		if (compareScores(state.score, best.score) > 0) best = state;
	}
	return {
		selectedIds: new Set(best.chosen.map((task) => task.taskId)),
		certificate: packingCertificate(
			best.chosen,
			"bounded_approximation",
			"beam_search",
			MAX_PACKING_BRANCHES,
			Math.min(branches, MAX_PACKING_BRANCHES),
			scoreFor(candidates),
		),
	};
}

function selectBoundedPacking(
	candidates: readonly NormalizedTask[],
	available: WorkConflictResourceRequest,
	conflicts: ReadonlyMap<string, ReadonlySet<string>>,
): PackingSelection {
	if (candidates.length === 0)
		return {
			selectedIds: new Set<string>(),
			certificate: packingCertificate([], "exact", "none", 0, 0, null),
		};
	const scalarSelection = selectScalarPacking(candidates, available, conflicts);
	if (scalarSelection !== undefined) return scalarSelection;
	if (candidates.length <= MAX_EXACT_CANDIDATES) return selectExactPacking(candidates, available, conflicts);
	return selectBeamPacking(candidates, available, conflicts);
}

/**
 * Choose a maximum-usefulness nonconflicting dispatch set from ready tasks.
 *
 * Args:
 * input: Canonical ready-task declarations, reconciled dependencies, protected scopes, path proofs, and host capacity.
 * Return: Deterministic graph, selected task IDs, explicit blocked reasons, and residual capacity.
 */
export async function planUsefulParallelDispatch(input: WorkConflictGraphInput): Promise<WorkConflictDispatchPlan> {
	assertRecord(input, "work conflict graph input");
	if (
		Object.hasOwn(input, "progressClaims") ||
		Object.hasOwn(input, "claimedProgress") ||
		Object.hasOwn(input, "progress")
	)
		throw new Error("caller progress claims are not scheduler authority.");
	const hostAuthorization = normalizeHostAuthorization(input.hostAuthorization);
	if (input.tasks !== undefined && input.readyTasks !== undefined)
		throw new Error("provide either tasks or readyTasks, not both.");
	const taskDeclarations = input.tasks ?? input.readyTasks;
	if (!Array.isArray(taskDeclarations)) throw new Error("work conflict graph tasks must be a finite array.");
	const activeDeclarations = input.activeTasks ?? [];
	if (!Array.isArray(activeDeclarations)) throw new Error("active tasks must be a finite array.");
	const protectedScopeDeclarations = input.protectedScopes ?? [];
	if (!Array.isArray(protectedScopeDeclarations)) throw new Error("protected scopes must be a finite array.");
	if (taskDeclarations.length + activeDeclarations.length > MAX_DECLARATIONS)
		throw new Error(`work conflict graph is bounded to ${MAX_DECLARATIONS} active and ready declarations.`);
	const completedTaskIds = canonicalTaskIds(input.completedTaskIds ?? [], "completed task IDs");
	const authoritativeTaskIds = canonicalTaskIds(input.authoritativeTaskIds, "authoritative task IDs");
	const authoritativeIds = new Set(authoritativeTaskIds);
	for (const taskId of completedTaskIds)
		if (!authoritativeIds.has(taskId))
			throw new Error(`completed task ${taskId} is absent from the authoritative graph.`);
	const capacity = normalizeCapacity(input.authenticatedCapacity);
	if (capacity.snapshotDigest !== hostAuthorization.capacityReceipt.payloadDigest)
		throw new Error("capacity receipt payload is not bound to the authenticated capacity snapshot.");
	const declaredPaths: string[] = [];
	const rawTasks = taskDeclarations.map((task, index) => {
		const normalized = normalizeTask(task, `task ${index}`);
		declaredPaths.push(...normalized.readPaths, ...normalized.writePaths);
		return normalized;
	});
	const rawActiveTasks = activeDeclarations.map((task, index) => {
		const normalized = normalizeTask(task, `active task ${index}`);
		declaredPaths.push(...normalized.readPaths, ...normalized.writePaths);
		return normalized;
	});
	const rawScopes = protectedScopeDeclarations.map(normalizeScope);
	assertUniqueScopeIds(rawScopes);
	for (const scope of rawScopes) declaredPaths.push(...scope.paths);
	const pathProofContext = normalizePathProofContext(input.pathProofContext, declaredPaths);
	if (!samePathRelationProof(pathProofContext, hostAuthorization.pathRelationProof))
		throw new Error("host path authorization is not bound to the complete workspace relation proof.");
	if (pathProofContext.proofDigest !== hostAuthorization.pathProofReceipt.payloadDigest)
		throw new Error("path proof receipt payload is not bound to the supplied path proofs.");
	const capacityAuthorization = await authorizeDispatchEvidence(
		hostAuthorization,
		hostAuthorization.capacityReceipt,
		"workflow_dispatch_capacity_attestation",
		capacity.snapshotDigest,
	);
	const pathAuthorization = await authorizeDispatchEvidence(
		hostAuthorization,
		hostAuthorization.pathProofReceipt,
		"workflow_dispatch_path_attestation",
		pathProofContext.proofDigest,
	);
	if (
		capacityAuthorization.authenticatedPrincipal !== pathAuthorization.authenticatedPrincipal ||
		capacityAuthorization.keyOwnerPrincipal !== pathAuthorization.keyOwnerPrincipal
	)
		throw new Error("capacity and path proofs are not cross-bound to one authenticated host principal.");
	const proofIdentities = pathProofContext.identities;
	const tasks = rawTasks.map((task) => normalizeTaskPaths(task, proofIdentities));
	const activeTasks = rawActiveTasks.map((task) => normalizeTaskPaths(task, proofIdentities));
	const protectedScopes = rawScopes.map((scope) => normalizeScopePaths(scope, proofIdentities));
	const readyIds = new Set<string>();
	for (const task of tasks) {
		if (readyIds.has(task.taskId)) throw new Error(`duplicate task ID ${task.taskId}.`);
		readyIds.add(task.taskId);
	}
	const activeIds = new Set<string>();
	for (const task of activeTasks) {
		if (readyIds.has(task.taskId) || activeIds.has(task.taskId))
			throw new Error(`duplicate active or ready task ID ${task.taskId}.`);
		activeIds.add(task.taskId);
	}
	for (const taskId of [...readyIds, ...activeIds])
		if (!authoritativeIds.has(taskId)) throw new Error(`task ${taskId} is absent from the authoritative graph.`);
	for (const taskId of completedTaskIds) {
		if (readyIds.has(taskId) || activeIds.has(taskId))
			throw new Error(`reconciled task ${taskId} is both completed and active or ready.`);
	}
	for (const task of activeTasks) {
		for (const dependency of task.dependencies) {
			if (readyIds.has(dependency))
				throw new Error(`active task ${task.taskId} depends on a ready task ${dependency}.`);
		}
	}
	const operationDigest = operationDigestFromNormalized({
		tasks,
		activeTasks,
		completedTaskIds,
		authoritativeTaskIds,
		protectedScopes,
		capacity,
		pathProofDigest: pathProofContext.proofDigest,
	});
	if (operationDigest !== hostAuthorization.operationDigest)
		throw new Error("host operation digest is not bound to the canonical dispatch graph.");
	const graph = createGraph(tasks);
	let used = emptyRequest();
	for (const activeTask of activeTasks) used = addRequest(used, activeTask.resourceRequest, "active resource usage");
	const reserved = Object.freeze({
		resources: capacity.protectedResourceReserve,
		acceleratorPools: Object.freeze([]),
		providerPools: Object.freeze([]),
		controlCapacity: capacity.protectedControlReserve,
	});
	used = addRequest(used, reserved, "protected control reserve");
	const totalAvailable: WorkConflictResourceRequest = Object.freeze({
		resources: capacity.resources,
		acceleratorPools: capacity.acceleratorPools,
		providerPools: capacity.providerPools,
		controlCapacity: capacity.controlCapacity,
	});
	if (!fitsRequest(used, totalAvailable))
		throw new Error("active resource usage oversubscription exceeds authenticated capacity.");
	const remainingAfterActive = subtractRequest(totalAvailable, used);
	const edgeByTask = new Map<string, Map<string, readonly WorkConflictEdgeReason[]>>();
	for (const edge of graph.edges) {
		if (!edgeByTask.has(edge.leftTaskId)) edgeByTask.set(edge.leftTaskId, new Map());
		if (!edgeByTask.has(edge.rightTaskId)) edgeByTask.set(edge.rightTaskId, new Map());
		edgeByTask.get(edge.leftTaskId)?.set(edge.rightTaskId, edge.reasons);
		edgeByTask.get(edge.rightTaskId)?.set(edge.leftTaskId, edge.reasons);
	}
	const activeEdgeByTask = new Map<string, Set<string>>();
	const activeDuplicateByTask = new Map<string, string[]>();
	for (const task of tasks) {
		const activeConflicts = new Set<string>();
		const duplicates: string[] = [];
		for (const activeTask of activeTasks) {
			if (
				hasWriteWriteOverlap(task, activeTask) ||
				hasReadWriteOverlap(task, activeTask) ||
				hasReadWriteOverlap(activeTask, task)
			)
				activeConflicts.add(activeTask.taskId);
			if (duplicateIdentity(task) === duplicateIdentity(activeTask)) duplicates.push(activeTask.taskId);
		}
		if (activeConflicts.size > 0) activeEdgeByTask.set(task.taskId, activeConflicts);
		if (duplicates.length > 0) activeDuplicateByTask.set(task.taskId, duplicates);
	}
	const baseReasons = new Map<string, WorkConflictBlockReason[]>();
	const baseConflicts = new Map<string, string[]>();
	const candidates: NormalizedTask[] = [];
	for (const task of tasks) {
		const reasons: WorkConflictBlockReason[] = [];
		const conflictsWith: string[] = [];
		if (task.dependencies.some((dependency) => !completedTaskIds.includes(dependency)))
			reasons.push("dependency_wait");
		if (protectedScopes.some((scope) => hasScopeOverlap(task, scope))) reasons.push("protected_scope");
		if (task.usefulness <= 0) reasons.push("not_useful");
		const activeConflicts = activeEdgeByTask.get(task.taskId) ?? new Set<string>();
		if (activeConflicts.size > 0) {
			reasons.push("active_conflict");
			conflictsWith.push(...activeConflicts);
		}
		const activeDuplicates = activeDuplicateByTask.get(task.taskId) ?? [];
		if (activeDuplicates.length > 0) {
			reasons.push("duplicate_work");
			conflictsWith.push(...activeDuplicates);
		}
		if (!fitsRequest(task.resourceRequest, remainingAfterActive)) reasons.push("resource_capacity");
		baseReasons.set(task.taskId, reasons);
		baseConflicts.set(task.taskId, conflictsWith);
		if (reasons.length === 0) candidates.push(task);
	}
	const conflictSets = new Map<string, ReadonlySet<string>>();
	for (const candidate of candidates) {
		const conflicts = new Set<string>();
		for (const [otherTaskId, reasons] of edgeByTask.get(candidate.taskId) ?? [])
			if (reasons.length > 0) conflicts.add(otherTaskId);
		conflictSets.set(candidate.taskId, conflicts);
	}
	const packingSelection = selectBoundedPacking(candidates, remainingAfterActive, conflictSets);
	const selectedIds = packingSelection.selectedIds;
	const selectedTasks = candidates.filter((task) => selectedIds.has(task.taskId));
	const selectedUsage = selectedTasks.reduce(
		(sum, task) => addRequest(sum, task.resourceRequest, "selected resource usage"),
		emptyRequest(),
	);
	for (const task of tasks) {
		const reasons = [...(baseReasons.get(task.taskId) ?? [])];
		const conflictsWith = [...(baseConflicts.get(task.taskId) ?? [])];
		if (!selectedIds.has(task.taskId)) {
			for (const selectedTask of selectedTasks) {
				const reasonsForEdge = edgeByTask.get(task.taskId)?.get(selectedTask.taskId);
				if (reasonsForEdge !== undefined) {
					if (reasonsForEdge.includes("duplicate_work")) reasons.push("duplicate_work");
					if (reasonsForEdge.some((reason) => reason !== "duplicate_work")) reasons.push("conflict");
					conflictsWith.push(selectedTask.taskId);
				}
			}
			if (!fitsRequest(task.resourceRequest, subtractRequest(remainingAfterActive, selectedUsage)))
				reasons.push("resource_capacity");
			if (reasons.length === 0) reasons.push("packing_not_selected");
		}
		if (reasons.length > 0) baseReasons.set(task.taskId, reasons);
		if (reasons.length > 0) baseConflicts.set(task.taskId, conflictsWith);
	}
	const idleCapacity = subtractRequest(remainingAfterActive, selectedUsage);
	const blockedTasks = Object.freeze(
		[...tasks]
			.filter((task) => !selectedIds.has(task.taskId))
			.sort(compareTaskIds)
			.map((task) =>
				blockedTask(
					task.taskId,
					baseReasons.get(task.taskId) ?? ["packing_not_selected"],
					baseConflicts.get(task.taskId) ?? [],
				),
			),
	);
	return Object.freeze({
		selectedTaskIds: Object.freeze([...selectedIds].sort(compareCodePointStrings)),
		blockedTasks,
		idleCapacity,
		graph,
		packingCertificate: packingSelection.certificate,
	});
}

export const selectUsefulParallelDispatch = planUsefulParallelDispatch;
export const chooseUsefulParallelDispatch = planUsefulParallelDispatch;

/**
 * Build the canonical conflict graph for a ready task declaration.
 *
 * Args:
 * input: Conflict graph input whose task declarations will be normalized and graphed.
 * Return: Bounded graph with deterministic nodes and conflict edges.
 */
export async function buildWorkConflictGraph(input: WorkConflictGraphInput): Promise<WorkConflictGraph> {
	return (await planUsefulParallelDispatch(input)).graph;
}
