import type {
	WorkflowArtifactRef,
	WorkflowAuthorityCapability,
	WorkflowControlCapacityVector,
	WorkflowEpochRef,
	WorkflowProviderResource,
	WorkflowResourceEnvelope,
	WorkflowResourceVector,
	WorkflowTask,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import { assertFiniteWorkflowControlCapacity, assertFiniteWorkflowResourceVector } from "./resources.js";

export type { WorkflowTask } from "./contracts.js";

export type WorkflowTaskWaitReason = "dependency_wait" | "ownership_wait" | "resource_wait" | "authority_wait";

export type WorkflowTaskStatus = WorkflowTask["status"];

export interface WorkflowTaskGraphContext {
	knownSkillSnapshotDigests: readonly string[];
	allowedAuthority: readonly WorkflowAuthorityCapability[];
	workspacePaths: readonly string[];
	generatedOutputPaths: readonly string[];
	namedContracts: readonly string[];
}

export interface WorkflowTaskGraph {
	graphRevision: number;
	tasks: readonly WorkflowTask[];
	byId: ReadonlyMap<string, WorkflowTask>;
	allowedAuthority: readonly WorkflowAuthorityCapability[];
	ownershipPaths: readonly string[];
	generatedOutputPaths: readonly string[];
	lockPaths: readonly string[];
	namedContracts: readonly string[];
	graphDigest: string;
}

type WorkflowProviderIdempotency = WorkflowProviderResource["idempotency"];

const PROVIDER_IDEMPOTENCY_RANK: Readonly<Record<WorkflowProviderIdempotency, number>> = {
	none: 0,
	host_reconciled: 1,
	provider_native: 2,
};

function compareCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftCodePoints[index] !== rightCodePoints[index]) {
			return leftCodePoints[index] - rightCodePoints[index];
		}
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function assertCanonicalGraphValue(value: unknown, label: string, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
		return;
	}
	if (typeof value === "function" || typeof value !== "object")
		throw new Error(`${label} contains a non-canonical value.`);
	if (ancestors.has(value)) throw new Error(`${label} contains a cycle.`);
	ancestors.add(value);
	if (Array.isArray(value)) {
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key))))
			throw new Error(`${label} contains a hidden array member.`);
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index)) throw new Error(`${label} contains a sparse array.`);
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined)
				throw new Error(`${label} contains an accessor or hidden array member.`);
			assertCanonicalGraphValue(value[index], `${label}[${index}]`, ancestors);
		}
		ancestors.delete(value);
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is not a plain object.`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new Error(`${label} contains a symbol member.`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined)
			throw new Error(`${label}.${key} is hidden or accessor-backed.`);
		assertCanonicalGraphValue(descriptor.value, `${label}.${key}`, ancestors);
	}
	ancestors.delete(value);
}

function canonicalStrings<T extends string>(value: readonly T[] | unknown, label: string): readonly T[] {
	if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string" || item.length === 0))
		throw new Error(`${label} must contain non-empty strings.`);
	return Object.freeze([...new Set(value as readonly T[])].sort(compareCodePointStrings));
}

class ImmutableWorkflowTaskMap implements ReadonlyMap<string, WorkflowTask> {
	readonly #entries: ReadonlyMap<string, WorkflowTask>;

	constructor(tasks: readonly WorkflowTask[]) {
		const entries = new Map<string, WorkflowTask>();
		for (const task of tasks) entries.set(task.taskId, task);
		this.#entries = entries;
		Object.freeze(this);
	}

	get size(): number {
		return this.#entries.size;
	}

	get(taskId: string): WorkflowTask | undefined {
		return this.#entries.get(taskId);
	}

	has(taskId: string): boolean {
		return this.#entries.has(taskId);
	}

	entries(): MapIterator<[string, WorkflowTask]> {
		return this.#entries.entries();
	}

	keys(): MapIterator<string> {
		return this.#entries.keys();
	}

	values(): MapIterator<WorkflowTask> {
		return this.#entries.values();
	}

	forEach(
		callbackfn: (value: WorkflowTask, key: string, map: ReadonlyMap<string, WorkflowTask>) => void,
		thisArg?: unknown,
	): void {
		this.#entries.forEach((value, key) => {
			callbackfn.call(thisArg, value, key, this);
		});
	}

	[Symbol.iterator](): MapIterator<[string, WorkflowTask]> {
		return this.entries();
	}
}

/**
 * Parse and validate a canonical relative workflow path.
 *
 * Args:
 * value: Relative path to validate.
 * Return: Canonical path components in their original order.
 */
export function parseWorkflowCanonicalPath(value: string): readonly string[] {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.charCodeAt(0) === 47 ||
		value.charCodeAt(value.length - 1) === 47 ||
		value.includes("//") ||
		value.includes("\\") ||
		value.includes("\0") ||
		/^[A-Za-z]:/.test(value)
	) {
		throw new Error("Workflow path must be a canonical relative path without separators, drives, or escapes.");
	}
	if (value.normalize("NFC") !== value) throw new Error("Workflow path must use canonical Unicode normalization.");
	const parts = value.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
		throw new Error("Workflow path contains an unsafe component.");
	}
	return parts;
}

function assertWorkflowProviderIdempotency(vector: WorkflowResourceVector): void {
	for (const provider of vector.providers) {
		if (!Object.hasOwn(PROVIDER_IDEMPOTENCY_RANK, provider.idempotency)) {
			throw new Error("Workflow provider capacity has an invalid idempotency capability.");
		}
	}
}

function assertWorkflowResourceVector(vector: WorkflowResourceVector): void {
	assertFiniteWorkflowResourceVector(vector);
	assertWorkflowProviderIdempotency(vector);
}

function assertWorkflowTaskResourceShape(task: WorkflowTask): void {
	if (!Number.isSafeInteger(task.planRevision) || task.planRevision < 1) {
		throw new Error(`Task ${task.taskId} has an invalid plan revision.`);
	}
	assertWorkflowResourceVector(task.declaredResourceVector);
	assertFiniteWorkflowControlCapacity(task.declaredControlCapacity);
	const dynamicFields = [
		task.inputRefs,
		task.boundaryIds,
		task.outputRefs,
		task.evidencePolicy,
		task.evidenceKind,
		task.budget,
		task.recoveryPolicy,
		task.taskGraphSourceDigest,
	];
	if (dynamicFields.some((field) => field !== undefined) && dynamicFields.some((field) => field === undefined))
		throw new Error(`Task ${task.taskId} has an incomplete graph-source contract.`);
	if (task.inputRefs === undefined) return;
	if (
		!Array.isArray(task.inputRefs) ||
		!Array.isArray(task.boundaryIds) ||
		!Array.isArray(task.outputRefs) ||
		task.inputRefs.some((ref) => typeof ref !== "string" || ref.length === 0) ||
		task.boundaryIds.some((boundaryId) => typeof boundaryId !== "string" || boundaryId.length === 0) ||
		task.outputRefs.length === 0 ||
		task.outputRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
	)
		throw new Error(`Task ${task.taskId} has invalid graph-source references.`);
	const evidencePolicy = task.evidencePolicy;
	if (
		evidencePolicy === undefined ||
		typeof evidencePolicy.kind !== "string" ||
		evidencePolicy.kind.length === 0 ||
		!Number.isSafeInteger(evidencePolicy.maxBytes) ||
		evidencePolicy.maxBytes < 1 ||
		!Number.isSafeInteger(evidencePolicy.maxItems) ||
		evidencePolicy.maxItems < 1 ||
		typeof evidencePolicy.independent !== "boolean"
	)
		throw new Error(`Task ${task.taskId} has invalid evidence policy.`);
	if (task.evidenceKind !== evidencePolicy.kind) throw new Error(`Task ${task.taskId} has an unbound evidence kind.`);
	const budget = task.budget;
	if (
		budget === undefined ||
		!Number.isSafeInteger(budget.tokenLimit) ||
		budget.tokenLimit < 0 ||
		!Number.isSafeInteger(budget.wallTimeLimitSeconds) ||
		budget.wallTimeLimitSeconds < 0 ||
		!Number.isSafeInteger(budget.spendLimitMicrounits) ||
		budget.spendLimitMicrounits < 0
	)
		throw new Error(`Task ${task.taskId} has invalid budget.`);
	if (task.recoveryPolicy !== "retry" && task.recoveryPolicy !== "replan" && task.recoveryPolicy !== "block")
		throw new Error(`Task ${task.taskId} has invalid recovery policy.`);
	if (!/^[a-f0-9]{64}$/u.test(task.taskGraphSourceDigest ?? ""))
		throw new Error(`Task ${task.taskId} has an invalid graph-source digest.`);
}

function freezeStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...values]);
}

function freezeResourceVector(vector: WorkflowResourceVector): WorkflowResourceVector {
	const accelerators = Object.freeze(vector.accelerators.map((accelerator) => Object.freeze({ ...accelerator })));
	const providers = Object.freeze(vector.providers.map((provider) => Object.freeze({ ...provider })));
	return Object.freeze({ ...vector, accelerators, providers });
}

function freezeControlCapacity(capacity: WorkflowControlCapacityVector): WorkflowControlCapacityVector {
	return Object.freeze({ ...capacity });
}

function freezeTask(task: WorkflowTask): WorkflowTask {
	return Object.freeze({
		...task,
		requirementIds: freezeStrings(task.requirementIds),
		completionCriteria: freezeStrings(task.completionCriteria),
		dependencyTaskIds: freezeStrings(task.dependencyTaskIds),
		...(task.inputRefs === undefined ? {} : { inputRefs: freezeStrings(task.inputRefs) }),
		...(task.boundaryIds === undefined ? {} : { boundaryIds: freezeStrings(task.boundaryIds) }),
		...(task.outputRefs === undefined ? {} : { outputRefs: freezeStrings(task.outputRefs) }),
		...(task.evidencePolicy === undefined ? {} : { evidencePolicy: Object.freeze({ ...task.evidencePolicy }) }),
		...(task.budget === undefined ? {} : { budget: Object.freeze({ ...task.budget }) }),
		ownedPaths: freezeStrings(task.ownedPaths),
		ownedContracts: freezeStrings(task.ownedContracts),
		requiredSkillSnapshotDigests: freezeStrings(task.requiredSkillSnapshotDigests),
		verificationCommandDigests: freezeStrings(task.verificationCommandDigests),
		authority: Object.freeze([...task.authority]),
		declaredResourceVector: freezeResourceVector(task.declaredResourceVector),
		declaredControlCapacity: freezeControlCapacity(task.declaredControlCapacity),
		attemptIds: freezeStrings(task.attemptIds),
	});
}

function assertWorkflowEnvelopeResourceShape(envelope: WorkflowResourceEnvelope): void {
	assertWorkflowResourceVector(envelope.resources);
	assertWorkflowResourceVector(envelope.controlPlaneReserve);
	assertFiniteWorkflowControlCapacity(envelope.controlPlaneReserveCapacity);
	assertFiniteWorkflowControlCapacity(envelope.controlCapacity);
	assertFiniteWorkflowControlCapacity(envelope.workerCapacity);
	for (const value of [envelope.processSlots, envelope.childSessionSlots, envelope.candidateSlots]) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error("Workflow resource envelope scalar capacity must be finite and non-negative.");
		}
	}
}

function pathOverlaps(left: string, right: string): boolean {
	const isPrefix = (prefix: string, value: string): boolean => {
		const prefixParts = parseWorkflowCanonicalPath(prefix);
		const valueParts = parseWorkflowCanonicalPath(value);
		return prefixParts.length <= valueParts.length && prefixParts.every((part, index) => part === valueParts[index]);
	};
	return isPrefix(left, right) || isPrefix(right, left);
}

function pathIsWithin(workspaceRoot: string, ownedPath: string): boolean {
	const rootParts = parseWorkflowCanonicalPath(workspaceRoot);
	const ownedParts = parseWorkflowCanonicalPath(ownedPath);
	return rootParts.length <= ownedParts.length && rootParts.every((part, index) => part === ownedParts[index]);
}

function ownershipOverlaps(left: WorkflowTask, right: WorkflowTask): boolean {
	return (
		left.ownedPaths.some((leftPath) => right.ownedPaths.some((rightPath) => pathOverlaps(leftPath, rightPath))) ||
		left.ownedContracts.some((contract) => right.ownedContracts.includes(contract))
	);
}

function taskDependsOn(
	task: WorkflowTask,
	targetTaskId: string,
	byId: ReadonlyMap<string, WorkflowTask>,
	seen = new Set<string>(),
): boolean {
	if (task.dependencyTaskIds.includes(targetTaskId)) return true;
	if (seen.has(task.taskId)) return false;
	seen.add(task.taskId);
	return task.dependencyTaskIds.some((dependencyId) => {
		const dependency = byId.get(dependencyId);
		return dependency !== undefined && taskDependsOn(dependency, targetTaskId, byId, seen);
	});
}

function fitsControlCapacity(
	required: WorkflowControlCapacityVector,
	available: WorkflowControlCapacityVector,
): boolean {
	return (Object.keys(required) as (keyof WorkflowControlCapacityVector)[]).every(
		(dimension) => required[dimension] <= available[dimension],
	);
}

function fitsEnvelope(
	vector: WorkflowResourceVector,
	controlCapacity: WorkflowControlCapacityVector,
	envelope: WorkflowResourceEnvelope,
): boolean {
	const available = envelope.resources;
	const reserve = envelope.controlPlaneReserve;
	if (
		vector.cpuMilliCores > available.cpuMilliCores - reserve.cpuMilliCores ||
		vector.memoryBytes > available.memoryBytes - reserve.memoryBytes ||
		vector.diskBytes > available.diskBytes - reserve.diskBytes ||
		vector.ioWeight > available.ioWeight - reserve.ioWeight ||
		vector.networkEgressBytes > available.networkEgressBytes - reserve.networkEgressBytes ||
		vector.wallMilliseconds > available.wallMilliseconds - reserve.wallMilliseconds ||
		vector.monetaryMicrounits > available.monetaryMicrounits - reserve.monetaryMicrounits
	) {
		return false;
	}
	if (!fitsControlCapacity(controlCapacity, envelope.workerCapacity)) return false;
	return (
		vector.accelerators.every((required) => {
			const availablePool = available.accelerators.find(
				(candidate) => candidate.poolId === required.poolId && candidate.deviceType === required.deviceType,
			);
			const reservedPool = reserve.accelerators.find(
				(candidate) => candidate.poolId === required.poolId && candidate.deviceType === required.deviceType,
			);
			return (
				availablePool !== undefined &&
				availablePool.count - (reservedPool?.count ?? 0) >= required.count &&
				availablePool.memoryBytes - (reservedPool?.memoryBytes ?? 0) >= required.memoryBytes
			);
		}) &&
		vector.providers.every((required) => {
			const availablePool = available.providers.find((candidate) => candidate.poolId === required.poolId);
			const reservedPool = reserve.providers.find((candidate) => candidate.poolId === required.poolId);
			return (
				availablePool !== undefined &&
				PROVIDER_IDEMPOTENCY_RANK[availablePool.idempotency] >= PROVIDER_IDEMPOTENCY_RANK[required.idempotency] &&
				availablePool.concurrentRequests - (reservedPool?.concurrentRequests ?? 0) >= required.concurrentRequests &&
				availablePool.requestsPerMinute - (reservedPool?.requestsPerMinute ?? 0) >= required.requestsPerMinute &&
				availablePool.totalRequests - (reservedPool?.totalRequests ?? 0) >= required.totalRequests &&
				availablePool.inputTokens - (reservedPool?.inputTokens ?? 0) >= required.inputTokens &&
				availablePool.outputTokens - (reservedPool?.outputTokens ?? 0) >= required.outputTokens
			);
		})
	);
}

/**
 * Validate a task DAG and derive its deterministic worker-free graph projection.
 *
 * Args:
 * tasks: Frozen workflow tasks to validate.
 * context: Host-known skill, authority, workspace, output, and contract boundaries.
 * Return: Validated graph with sorted projections and a canonical digest.
 */
export function validateWorkflowTaskGraph(
	tasks: readonly WorkflowTask[],
	context: WorkflowTaskGraphContext,
): WorkflowTaskGraph {
	assertCanonicalGraphValue(tasks, "workflow task graph");
	assertCanonicalGraphValue(context, "workflow task graph context");
	if (!Array.isArray(tasks)) throw new Error("Workflow task graph tasks must be an array.");
	const taskList = tasks as readonly WorkflowTask[];
	const ids = new Set<string>();
	const byId = new Map<string, WorkflowTask>();
	const knownSkillSnapshotDigests = canonicalStrings(
		context.knownSkillSnapshotDigests,
		"known skill snapshot digests",
	);
	const allowedAuthorityContext = canonicalStrings<WorkflowAuthorityCapability>(
		context.allowedAuthority,
		"allowed authority",
	);
	const workspacePaths = canonicalStrings(context.workspacePaths, "workspace paths");
	const generatedOutputPathsContext = canonicalStrings(context.generatedOutputPaths, "generated output paths");
	const namedContractsContext = canonicalStrings(context.namedContracts, "named contracts");
	[...workspacePaths, ...generatedOutputPathsContext].forEach(parseWorkflowCanonicalPath);
	const workspaceAllows = (path: string): boolean => workspacePaths.some((root) => pathIsWithin(root, path));

	for (const task of taskList) {
		if (task.taskId.length === 0 || ids.has(task.taskId)) {
			throw new Error("Workflow task graph has a duplicate or empty task id.");
		}
		ids.add(task.taskId);
		if (task.status === "cancelled" && task.attemptIds.length === 0) {
			throw new Error("A cancelled task must retain its attempt history.");
		}
		assertWorkflowTaskResourceShape(task);
		if (task.requiredSkillSnapshotDigests.some((digest) => !knownSkillSnapshotDigests.includes(digest))) {
			throw new Error(`Task ${task.taskId} references an unknown skill snapshot.`);
		}
		if (task.authority.some((capability) => !allowedAuthorityContext.includes(capability))) {
			throw new Error(`Task ${task.taskId} requests an unauthorized capability.`);
		}
		task.ownedPaths.forEach(parseWorkflowCanonicalPath);
		if (task.ownedPaths.some((path) => !workspaceAllows(path))) {
			throw new Error(`Task ${task.taskId} owns a path outside the workspace.`);
		}
		if (task.ownedContracts.some((contract) => !namedContractsContext.includes(contract))) {
			throw new Error(`Task ${task.taskId} owns an unknown contract.`);
		}
		byId.set(task.taskId, task);
	}
	const taskGraphSourceDigests = new Set(
		taskList.map((task) => task.taskGraphSourceDigest).filter((digest): digest is string => digest !== undefined),
	);
	if (
		taskGraphSourceDigests.size > 1 ||
		(taskGraphSourceDigests.size === 1 && taskList.some((task) => task.taskGraphSourceDigest === undefined))
	)
		throw new Error("Workflow tasks bind different graph sources.");

	for (const task of taskList) {
		if (task.dependencyTaskIds.some((dependency) => !byId.has(dependency) || dependency === task.taskId)) {
			throw new Error(`Task ${task.taskId} has a missing or self dependency.`);
		}
	}

	for (let leftIndex = 0; leftIndex < taskList.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < taskList.length; rightIndex += 1) {
			const left = taskList[leftIndex];
			const right = taskList[rightIndex];
			if (
				ownershipOverlaps(left, right) &&
				!taskDependsOn(left, right.taskId, byId) &&
				!taskDependsOn(right, left.taskId, byId)
			) {
				throw new Error(
					`Independent tasks ${left.taskId} and ${right.taskId} reserve overlapping owned paths or contracts.`,
				);
			}
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): void => {
		if (visiting.has(taskId)) throw new Error("Workflow task graph contains a dependency cycle.");
		if (visited.has(taskId)) return;
		visiting.add(taskId);
		for (const dependency of byId.get(taskId)?.dependencyTaskIds ?? []) visit(dependency);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const task of taskList) visit(task.taskId);

	const ownershipPaths = Object.freeze(
		[...new Set(taskList.flatMap((task) => task.ownedPaths))].sort(compareCodePointStrings),
	);
	const generatedOutputPaths = Object.freeze([...new Set(generatedOutputPathsContext)].sort());
	const lockPaths = Object.freeze([] as string[]);
	const namedContracts = Object.freeze(
		[...new Set(taskList.flatMap((task) => task.ownedContracts))].sort(compareCodePointStrings),
	);
	const allowedAuthority: readonly WorkflowAuthorityCapability[] = Object.freeze(
		[...allowedAuthorityContext].sort(compareCodePointStrings),
	);
	const graphRevision = Math.max(1, ...taskList.map((task) => task.planRevision));
	const sortedTasks = Object.freeze(
		[...taskList]
			.map(
				(task): WorkflowTask =>
					freezeTask({
						...task,
						dependencyTaskIds: [...task.dependencyTaskIds].sort(),
						ownedPaths: [...task.ownedPaths].sort(),
						ownedContracts: [...task.ownedContracts].sort(),
						authority: [...task.authority].sort(),
						requiredSkillSnapshotDigests: [...task.requiredSkillSnapshotDigests].sort(),
					}),
			)
			.sort((left, right) => compareCodePointStrings(left.taskId, right.taskId)),
	);
	const sortedById = new ImmutableWorkflowTaskMap(sortedTasks);
	return Object.freeze({
		graphRevision,
		tasks: sortedTasks,
		byId: sortedById,
		allowedAuthority,
		ownershipPaths,
		generatedOutputPaths,
		lockPaths,
		namedContracts,
		graphDigest: digestObject({
			graphRevision,
			tasks: sortedTasks,
			allowedAuthority,
			ownershipPaths,
			generatedOutputPaths,
			lockPaths,
			namedContracts,
		}),
	});
}

/**
 * Compute pure task readiness and canonical resource evidence.
 *
 * Args:
 * graph: Validated task graph to inspect.
 * running: Active tasks whose ownership must not overlap a candidate.
 * envelope: Approved resource envelope used for fit checks.
 * Return: Sorted readiness records with every applicable wait reason.
 */
export function computeTaskReadiness(
	graph: WorkflowTaskGraph,
	running: readonly WorkflowTask[],
	envelope: WorkflowResourceEnvelope,
): readonly {
	taskId: string;
	ready: boolean;
	waitReasons: readonly WorkflowTaskWaitReason[];
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	envelopeDigest: string;
}[] {
	assertWorkflowEnvelopeResourceShape(envelope);
	for (const active of running) {
		assertWorkflowTaskResourceShape(active);
		active.ownedPaths.forEach(parseWorkflowCanonicalPath);
	}
	return graph.tasks
		.map((task) => {
			const waitReasons: WorkflowTaskWaitReason[] = [];
			if (
				task.status !== "ready" ||
				task.dependencyTaskIds.some((dependency) => graph.byId.get(dependency)?.status !== "accepted")
			) {
				waitReasons.push("dependency_wait");
			}
			if (running.some((active) => ownershipOverlaps(task, active))) waitReasons.push("ownership_wait");
			if (!fitsEnvelope(task.declaredResourceVector, task.declaredControlCapacity, envelope)) {
				waitReasons.push("resource_wait");
			}
			if (task.authority.some((capability) => !graph.allowedAuthority.includes(capability))) {
				waitReasons.push("authority_wait");
			}
			return {
				taskId: task.taskId,
				ready: waitReasons.length === 0,
				waitReasons,
				canonicalLedgerRef: envelope.canonicalLedgerRef,
				canonicalLedgerDigest: envelope.canonicalLedgerDigest,
				envelopeDigest: envelope.envelopeDigest,
			};
		})
		.sort((left, right) => compareCodePointStrings(left.taskId, right.taskId));
}

/**
 * Return task IDs that satisfy every worker-free readiness predicate.
 *
 * Args:
 * graph: Validated task graph to inspect.
 * running: Active tasks whose ownership must not overlap a candidate.
 * envelope: Approved resource envelope used for fit checks.
 * Return: Sorted IDs of ready tasks.
 */
export function computeReadyTaskIds(
	graph: WorkflowTaskGraph,
	running: readonly WorkflowTask[],
	envelope: WorkflowResourceEnvelope,
): readonly string[] {
	return computeTaskReadiness(graph, running, envelope)
		.filter((item) => item.ready)
		.map((item) => item.taskId);
}

const TASK_STATUS_TRANSITIONS: Readonly<Record<WorkflowTaskStatus, readonly WorkflowTaskStatus[]>> = {
	pending: ["ready", "cancelled"],
	ready: ["admitted", "blocked", "cancelled"],
	admitted: ["running", "blocked", "cancelled"],
	running: ["awaiting_audit", "blocked", "cancelled"],
	awaiting_audit: ["accepted", "needs_fix", "blocked", "cancelled"],
	accepted: [],
	needs_fix: ["ready", "blocked", "cancelled"],
	blocked: ["ready", "cancelled"],
	cancelled: [],
};

/**
 * Apply one closed task-status transition using digest and epoch compare-and-swap guards.
 *
 * Args:
 * task: Current frozen task value.
 * nextStatus: Requested status in the closed lifecycle.
 * expectedStatusDigest: Digest of the exact current task value.
 * epoch: Store and coordinator epoch at which the transition was observed.
 * Return: New task value with only its status changed. The reducer/store remains responsible for comparing this epoch and digest with current persisted state.
 */
export function transitionWorkflowTask(
	task: WorkflowTask,
	nextStatus: WorkflowTaskStatus,
	expectedStatusDigest: string,
	epoch: WorkflowEpochRef,
): WorkflowTask {
	const epochIsRecord = typeof epoch === "object" && epoch !== null;
	const epochKeys = epochIsRecord ? Object.keys(epoch) : [];
	if (
		!epochIsRecord ||
		epochKeys.length !== 2 ||
		!epochKeys.includes("storeEpoch") ||
		!epochKeys.includes("coordinatorEpoch") ||
		!Number.isSafeInteger(epoch.storeEpoch) ||
		epoch.storeEpoch <= 0 ||
		!Number.isSafeInteger(epoch.coordinatorEpoch) ||
		epoch.coordinatorEpoch <= 0
	) {
		throw new Error("Workflow task transition epoch is invalid.");
	}
	if (digestObject(task) !== expectedStatusDigest) {
		throw new Error("Workflow task status compare-and-swap digest is stale.");
	}
	if (!TASK_STATUS_TRANSITIONS[task.status].includes(nextStatus)) {
		throw new Error(`Workflow task transition ${task.status} -> ${nextStatus} is not allowed.`);
	}
	return { ...task, status: nextStatus };
}
