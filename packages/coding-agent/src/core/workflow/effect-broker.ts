import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
	canonicalJsonBytes,
	type DurableDecisionRef,
	type DurableEffectClass,
	type DurableMateriality,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowApprovalResponse,
	type WorkflowArtifactRef,
	type WorkflowChildProcessBinding,
	type WorkflowConcreteEffect,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowResourceVector,
	type WorkflowRevisionBoundaryContext,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStore,
} from "./contracts.js";
import {
	type WorkflowIntentRedManifest,
	type WorkflowIntentRedMutationAuthorization,
	type WorkflowIntentRedMutationScope,
	workflowIntentRedMutationEffectDigest,
	workflowIntentRedMutationOperationDigest,
	workflowIntentRedMutationResourceDigest,
	workflowIntentRedMutationScopeDigest,
	workflowIntentRedScopeExceededEventPayload,
} from "./intent-red-manifest.js";
import {
	assertWorkflowProcessRevisionBoundary,
	assertWorkflowProcessSpawnDescriptor,
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	canonicalWorkflowProcessGroupDigest,
	commitWorkflowRuntimeEvent,
	type WorkflowProcessEpochManager,
	type WorkflowProcessGroupController,
	type WorkflowProcessSpawnDescriptor,
} from "./process-groups.js";

export type WorkflowEffectHost =
	| "bash"
	| "edit"
	| "ipython"
	| "package_manager"
	| "child_process"
	| "artifact_publish"
	| "session_mutation";

export type WorkflowConcreteEffectKind = WorkflowConcreteEffect["kind"];

export interface WorkflowClassifiedEffect {
	readonly effect: WorkflowConcreteEffect;
	readonly host: WorkflowEffectHost;
	readonly effectClass: DurableEffectClass;
	readonly materiality: "none" | "durable" | "external";
	readonly derivedMateriality: DurableMateriality;
	readonly authority: "read_only" | "workspace_write" | "external_write";
	readonly normalizedReadSet: readonly string[];
	readonly normalizedWriteSet: readonly string[];
	readonly requiresUserApproval: boolean;
	readonly idempotencyKey: string;
	readonly resourceVector: WorkflowResourceVector;
	readonly conflictKeys: readonly string[];
}

export const WORKFLOW_EFFECT_OPERATION_POLICY: Readonly<
	Record<
		WorkflowConcreteEffectKind,
		{
			readonly effectClass: DurableEffectClass;
			readonly materiality: "none" | "durable" | "external";
			readonly derivedMateriality: DurableMateriality;
			readonly authority: "read_only" | "workspace_write" | "external_write";
			readonly requiresUserApproval: boolean;
		}
	>
> = {
	bash_exec: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: true,
	},
	file_read: {
		effectClass: "read_only",
		materiality: "none",
		derivedMateriality: "routine",
		authority: "read_only",
		requiresUserApproval: false,
	},
	file_write: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: false,
	},
	ipython_exec: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: false,
	},
	package_manager: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: true,
	},
	artifact_publish: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: false,
	},
	session_mutation: {
		effectClass: "owned_reversible_local_write",
		materiality: "durable",
		derivedMateriality: "material",
		authority: "workspace_write",
		requiresUserApproval: false,
	},
	child_process_spawn: {
		effectClass: "owned_reversible_local_write",
		materiality: "external",
		derivedMateriality: "material",
		authority: "external_write",
		requiresUserApproval: true,
	},
};

export interface WorkflowEffectHookRegistry {
	readonly hooks: ReadonlyMap<WorkflowConcreteEffectKind, string>;
	readonly capabilityDigest: string;
	readonly preimageResolverDigest: string;
	readonly approvalVerifierDigest: string;
	readonly evidenceWriterDigest: string;
	readonly registryDigest: string;
}

export function validateWorkflowEffectHookRegistry(registry: WorkflowEffectHookRegistry): void {
	const kinds = Object.keys(WORKFLOW_EFFECT_OPERATION_POLICY) as WorkflowConcreteEffectKind[];
	const expectedDigest = digestObject({
		hooks: [...registry.hooks.entries()].sort(([left], [right]) => left.localeCompare(right)),
		capabilityDigest: registry.capabilityDigest,
		preimageResolverDigest: registry.preimageResolverDigest,
		approvalVerifierDigest: registry.approvalVerifierDigest,
		evidenceWriterDigest: registry.evidenceWriterDigest,
	});
	if (
		registry.hooks.size !== kinds.length ||
		kinds.some((kind) => {
			const hook = registry.hooks.get(kind);
			return typeof hook !== "string" || hook.length === 0;
		}) ||
		[...registry.hooks.keys()].some((kind) => !kinds.includes(kind)) ||
		registry.registryDigest !== expectedDigest ||
		registry.capabilityDigest.length === 0 ||
		registry.preimageResolverDigest.length === 0 ||
		registry.approvalVerifierDigest.length === 0 ||
		registry.evidenceWriterDigest.length === 0
	)
		throw new WorkflowEffectError("workflow_effect_hook_registry_not_exhaustive");
}

export interface WorkflowEffectExecutionContext {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly revisionBoundary: WorkflowRevisionBoundaryContext;
	readonly decisionRef: DurableDecisionRef;
	readonly approvalResponse: WorkflowApprovalResponse | null;
	readonly idempotencyKey: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly resourceLeaseRef: WorkflowLeaseRef;
	readonly ownershipLeaseRef: WorkflowLeaseRef;
	readonly ownershipToken: WorkflowEffectOwnershipToken;
	/** Opaque host-issued RED receipt; workers must not inspect or manufacture it. */
	readonly intentRedAuthorization?: unknown;
	/** Host tuple used to bind RED authority to the current workflow state. */
	readonly intentRedCurrent?: {
		readonly stateDigest: string;
		readonly revision: number;
		readonly trustedNow: string;
		readonly executionIdentity?: string | null;
		readonly sessionId?: string | null;
	};
}

export interface WorkflowEffectOwnershipToken {
	readonly tokenId: string;
	readonly tokenDigest: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly resourceLeaseRef: WorkflowLeaseRef;
	readonly ownershipLeaseRef: WorkflowLeaseRef;
}

export interface WorkflowEffectResult {
	readonly status: "completed" | "already_completed" | "ambiguous" | "quarantined";
	readonly resultDigest: string | null;
	readonly evidenceArtifact: WorkflowArtifactRef | null;
}

export interface WorkflowIpythonExecutor {
	execute(input: {
		context: WorkflowEffectExecutionContext;
		effect: Extract<WorkflowConcreteEffect, { kind: "ipython_exec" }>;
		code: string;
	}): Promise<{ resultDigest: string; evidenceArtifact: WorkflowArtifactRef | null }>;
}

export interface WorkflowPackageManagerExecutor {
	execute(input: {
		context: WorkflowEffectExecutionContext;
		effect: Extract<WorkflowConcreteEffect, { kind: "package_manager" }>;
		arguments: readonly string[];
	}): Promise<{ resultDigest: string; evidenceArtifact: WorkflowArtifactRef | null }>;
}

export interface WorkflowSessionMutationExecutor {
	mutate(input: {
		context: WorkflowEffectExecutionContext;
		effect: Extract<WorkflowConcreteEffect, { kind: "session_mutation" }>;
		bytes: Uint8Array;
	}): Promise<{ resultDigest: string; evidenceArtifact: WorkflowArtifactRef | null }>;
}

export interface WorkflowChildProcessExecutor {
	spawn(input: {
		context: WorkflowEffectExecutionContext;
		effect: Extract<WorkflowConcreteEffect, { kind: "child_process_spawn" }>;
		executable: string;
		arguments: readonly string[];
		processGroupRequest: WorkflowProcessSpawnDescriptor;
	}): Promise<{ binding: WorkflowChildProcessBinding; resultDigest: string }>;
}

export interface WorkflowBashExecutor {
	exec(input: {
		context: WorkflowEffectExecutionContext;
		command: string;
		cwd: string;
		timeoutMs: number;
	}): Promise<unknown>;
}

export interface WorkflowEditExecutor {
	readFile(input: { context: WorkflowEffectExecutionContext; path: string }): Promise<Uint8Array>;
	writeFile(input: { context: WorkflowEffectExecutionContext; path: string; content: string }): Promise<void>;
}

export interface WorkflowDecisionApprovalVerifier {
	verify(input: {
		context: WorkflowEffectExecutionContext;
		effect: WorkflowConcreteEffect;
	}): Promise<"approved" | "rejected" | "not_required">;
}

export interface WorkflowApprovalProofVerifier {
	verifyAndConsume(input: {
		context: WorkflowEffectExecutionContext;
		effect: WorkflowConcreteEffect;
		decision: "approved" | "rejected" | "not_required";
		response: WorkflowApprovalResponse | null;
	}): Promise<boolean>;
}

export interface WorkflowEffectExecutors {
	readonly bash: WorkflowBashExecutor;
	readonly edit: WorkflowEditExecutor;
	readonly ipython: WorkflowIpythonExecutor;
	readonly packageManager: WorkflowPackageManagerExecutor;
	readonly session: WorkflowSessionMutationExecutor;
	readonly childProcess: WorkflowChildProcessExecutor;
}

export interface WorkflowEffectEvidenceSigner {
	sign(bytes: Uint8Array): Promise<{ signature: string; signingKeyId: string }>;
}

export interface WorkflowEffectIntentRedScopeResolution {
	readonly operationDigest: string;
	readonly resourceDigest: string;
	readonly affectedProductionSurface: readonly string[];
	readonly writeSet: readonly string[];
	readonly closureRationale: string;
}

export interface WorkflowEffectIntentRedInspection {
	readonly manifest: WorkflowIntentRedManifest;
	readonly authorizedScope: WorkflowIntentRedMutationScope;
	/** Present only when the host accepted a cross-cutting closure after independent review. */
	readonly adversarialReviewReceiptDigest?: string;
}

export interface WorkflowEffectIntentRedGateway {
	/** Resolve host-observed semantic and file closure without invoking the effect executor. */
	resolveScope(input: {
		readonly authorization: unknown;
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
	}): Promise<WorkflowEffectIntentRedScopeResolution>;
	/** Return immutable host scope data without consuming the one-use RED tokens. */
	inspect(input: {
		readonly authorization: unknown;
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
	}): Promise<WorkflowEffectIntentRedInspection>;
	/** Consume and return the stable one-use RED authorization after exact scope comparison. */
	authorize(input: {
		readonly authorization: unknown;
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
		readonly attemptedScope: WorkflowIntentRedMutationScope;
		readonly inspection: WorkflowEffectIntentRedInspection;
		readonly currentHead: WorkflowJournalHead;
	}): Promise<WorkflowIntentRedMutationAuthorization>;
	/** Optional urgent coordinator notification after a durable denial record is committed. */
	reportDenied?(input: {
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly attemptedScope: WorkflowIntentRedMutationScope;
		readonly payloadDigest: string;
		readonly reason: string;
	}): Promise<void> | void;
	/** Optional host check for out-of-band drift after the executor returns. */
	verifyPostEffect?(input: {
		readonly authorization: WorkflowIntentRedMutationAuthorization;
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
		readonly attemptedScope: WorkflowIntentRedMutationScope;
	}): Promise<void>;
}

export interface WorkflowEffectProducerSealFence {
	/** Reject writes after a producer's terminal artifact seal. */
	assertEffectAllowed(input: {
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
		readonly writeSet: readonly string[];
	}): Promise<void>;
	/** Detect an out-of-band write and invalidate the producer's terminal delivery. */
	verifyPostEffect?(input: {
		readonly context: WorkflowEffectExecutionContext;
		readonly effect: WorkflowConcreteEffect;
		readonly classified: WorkflowClassifiedEffect;
		readonly writeSet: readonly string[];
	}): Promise<void>;
}

interface WorkflowResolvedEffectPreimage {
	readonly codec: "canonical_json" | "utf8" | "binary";
	readonly bytes: Uint8Array;
}

export interface WorkflowEffectLeaseManager {
	assertActive(input: {
		readonly workflowId: string;
		readonly taskId: string;
		readonly attemptId: string;
		readonly executionKey: string;
		readonly effectDigest: string;
		readonly epochRef: WorkflowEpochRef;
		readonly leaseRef: WorkflowLeaseRef;
		readonly resourceLeaseRef: WorkflowLeaseRef;
		readonly ownershipLeaseRef: WorkflowLeaseRef;
	}): Promise<void>;
	assertOwnershipToken(input: {
		readonly workflowId: string;
		readonly taskId: string;
		readonly attemptId: string;
		readonly executionKey: string;
		readonly effectDigest: string;
		readonly epochRef: WorkflowEpochRef;
		readonly leaseRef: WorkflowLeaseRef;
		readonly resourceLeaseRef: WorkflowLeaseRef;
		readonly ownershipLeaseRef: WorkflowLeaseRef;
		readonly ownershipToken: WorkflowEffectOwnershipToken;
	}): Promise<void>;
	quarantine(input: {
		readonly workflowId: string;
		readonly taskId: string;
		readonly attemptId: string;
		readonly executionKey: string;
		readonly effectDigest: string;
		readonly leaseRef: WorkflowLeaseRef;
		readonly resourceLeaseRef: WorkflowLeaseRef;
		readonly ownershipLeaseRef: WorkflowLeaseRef;
		readonly ownershipToken: WorkflowEffectOwnershipToken;
		readonly epochRef: WorkflowEpochRef;
		readonly store: WorkflowRuntimeStore;
		readonly reason: string;
	}): Promise<unknown>;
}

export interface WorkflowEffectBrokerDependencies {
	readonly store: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly epochs: WorkflowProcessEpochManager;
	readonly leases: WorkflowEffectLeaseManager;
	readonly groups: WorkflowProcessGroupController;
	readonly workspaceRoot: string;
	readonly executors: WorkflowEffectExecutors;
	readonly preimages: {
		resolve(ref: WorkflowArtifactRef): Promise<{
			artifactRef: WorkflowArtifactRef;
			codec: "canonical_json" | "utf8" | "binary";
			immutable: true;
			bytes: Readonly<Uint8Array>;
			verifiedDigest: string;
			verifiedSizeBytes: number;
		}>;
	};
	readonly decisionVerifier: WorkflowDecisionApprovalVerifier;
	readonly approvalProof: WorkflowApprovalProofVerifier;
	readonly evidenceSigner: WorkflowEffectEvidenceSigner;
	readonly evidence?: unknown;
	readonly hookRegistry: WorkflowEffectHookRegistry;
	readonly writerIdentity: string;
	readonly readRevisionBoundaryContext?: WorkflowEffectRevisionReader["readRevisionBoundaryContext"];
	readonly revisionRegistry?: WorkflowEffectRevisionReader["revisionRegistry"];
	readonly intentRed?: WorkflowEffectIntentRedGateway;
	readonly producerSealFence?: WorkflowEffectProducerSealFence;
}

interface WorkflowEffectRevisionReader {
	readonly readRevisionBoundaryContext?: (
		workflowId: string,
		epochRef: WorkflowEpochRef,
		executionKey: string | null,
	) => Promise<{
		workflowId: string;
		epochRef: WorkflowEpochRef;
		executionKey: string | null;
		tupleDigest: string;
		leaseRef: WorkflowLeaseRef;
	}>;
	readonly revisionRegistry?: {
		assertActive(context: WorkflowRevisionBoundaryContext): Promise<void>;
	};
}

export class WorkflowEffectError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "WorkflowEffectError";
		this.code = code;
	}
}

export interface WorkflowEffectBroker {
	classify(effect: WorkflowConcreteEffect, context: WorkflowEffectExecutionContext): WorkflowClassifiedEffect;
	execute(effect: WorkflowConcreteEffect, context: WorkflowEffectExecutionContext): Promise<WorkflowEffectResult>;
	reconcile(
		effect: WorkflowConcreteEffect,
		idempotencyKey: string,
		epochRef: WorkflowEpochRef,
		context?: WorkflowEffectExecutionContext,
	): Promise<WorkflowEffectResult>;
	readiness(): { canExecute: boolean; blockingReasons: readonly string[] };
}

function zeroWorkflowResourceVector(): WorkflowResourceVector {
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

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameLease(left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean {
	return digestObject(left) === digestObject(right);
}

export function canonicalWorkflowEffectOwnershipTokenDigest(
	token: Omit<WorkflowEffectOwnershipToken, "tokenDigest">,
): string {
	return digestObject(token);
}

function assertEffectContextShape(context: WorkflowEffectExecutionContext): void {
	if (
		context.workflowId.length === 0 ||
		context.taskId.length === 0 ||
		context.attemptId.length === 0 ||
		context.executionKey.length === 0 ||
		!sameEpoch(context.epochRef, context.leaseRef) ||
		!sameEpoch(context.epochRef, context.resourceLeaseRef) ||
		!sameEpoch(context.epochRef, context.ownershipLeaseRef) ||
		!sameLease(context.revisionBoundary.leaseRef, context.leaseRef) ||
		context.ownershipToken.workflowId !== context.workflowId ||
		context.ownershipToken.taskId !== context.taskId ||
		context.ownershipToken.attemptId !== context.attemptId ||
		context.ownershipToken.executionKey !== context.executionKey ||
		!sameEpoch(context.ownershipToken.epochRef, context.epochRef) ||
		!sameLease(context.ownershipToken.resourceLeaseRef, context.resourceLeaseRef) ||
		!sameLease(context.ownershipToken.ownershipLeaseRef, context.ownershipLeaseRef) ||
		context.ownershipToken.tokenId.length === 0 ||
		context.ownershipToken.tokenDigest !==
			canonicalWorkflowEffectOwnershipTokenDigest({
				tokenId: context.ownershipToken.tokenId,
				workflowId: context.ownershipToken.workflowId,
				taskId: context.ownershipToken.taskId,
				attemptId: context.ownershipToken.attemptId,
				executionKey: context.ownershipToken.executionKey,
				epochRef: context.ownershipToken.epochRef,
				resourceLeaseRef: context.ownershipToken.resourceLeaseRef,
				ownershipLeaseRef: context.ownershipToken.ownershipLeaseRef,
			})
	)
		throw new WorkflowEffectError("workflow_effect_ownership_context_invalid");
}

function canonicalWorkspacePath(workspaceRoot: string, path: string, allowMissingLeaf: boolean): string {
	if (path.length === 0 || path.includes("\u0000")) throw new WorkflowEffectError("workflow_effect_path_empty");
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync.native(workspaceRoot);
	} catch {
		throw new WorkflowEffectError("workflow_effect_workspace_unavailable");
	}
	const candidate = resolve(canonicalRoot, path);
	let canonicalCandidate: string;
	try {
		canonicalCandidate = realpathSync.native(candidate);
	} catch {
		if (!allowMissingLeaf) throw new WorkflowEffectError("workflow_effect_path_unavailable");
		const canonicalParent = (() => {
			try {
				return realpathSync.native(dirname(candidate));
			} catch {
				throw new WorkflowEffectError("workflow_effect_path_unavailable");
			}
		})();
		canonicalCandidate = resolve(canonicalParent, candidate.slice(dirname(candidate).length + 1));
	}
	const pathFromRoot = relative(canonicalRoot, canonicalCandidate);
	if (
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		resolve(canonicalRoot, pathFromRoot) !== canonicalCandidate
	)
		throw new WorkflowEffectError("workflow_effect_path_outside_workspace");
	return canonicalCandidate;
}

function normalizedPath(workspaceRoot: string, path: string, allowMissingLeaf = false): string {
	return canonicalWorkspacePath(workspaceRoot, path, allowMissingLeaf);
}

function normalizedProductionPath(workspaceRoot: string, path: string): string {
	if (typeof path !== "string" || path.length === 0 || path.includes("\u0000"))
		throw new WorkflowEffectError("workflow_effect_intent_scope_invalid");
	const canonicalRoot = (() => {
		try {
			return realpathSync.native(workspaceRoot);
		} catch {
			throw new WorkflowEffectError("workflow_effect_workspace_unavailable");
		}
	})();
	const candidate = isAbsolute(path) ? normalizedPath(workspaceRoot, path, true) : resolve(canonicalRoot, path);
	const pathFromRoot = relative(canonicalRoot, candidate).replaceAll("\\", "/");
	if (
		pathFromRoot.length === 0 ||
		pathFromRoot === ".." ||
		pathFromRoot.startsWith("../") ||
		pathFromRoot.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	)
		throw new WorkflowEffectError("workflow_effect_path_outside_workspace");
	return pathFromRoot;
}

function normalizedProductionPathSet(
	workspaceRoot: string,
	paths: readonly string[],
	label: string,
): readonly string[] {
	if (!Array.isArray(paths) || paths.length === 0)
		throw new WorkflowEffectError("workflow_effect_intent_scope_invalid");
	const normalized = paths.map((path) => normalizedProductionPath(workspaceRoot, path));
	const unique = [...new Set(normalized)].sort();
	if (unique.length !== normalized.length)
		throw new WorkflowEffectError(`workflow_effect_intent_scope_${label}_duplicate`);
	return unique;
}

function assertWorkflowDigest(value: string, label: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) throw new WorkflowEffectError(`workflow_effect_intent_scope_${label}_invalid`);
}

function hasNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function intentRedRequired(classified: WorkflowClassifiedEffect): boolean {
	return classified.effect.kind !== "file_read" && classified.authority !== "read_only";
}

function defaultIntentRedScope(
	dependencies: WorkflowEffectBrokerDependencies,
	effect: WorkflowConcreteEffect,
	classified: WorkflowClassifiedEffect,
): WorkflowEffectIntentRedScopeResolution {
	if (effect.kind !== "file_write") throw new WorkflowEffectError("workflow_effect_intent_scope_unresolved");
	const path = normalizedProductionPath(dependencies.workspaceRoot, classified.normalizedWriteSet[0]!);
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: effect.operationId,
		taskId: classified.host,
		attemptId: effect.kind,
	});
	const operationDigest = workflowIntentRedMutationOperationDigest({
		manifestDigest: digestObject({ kind: "unbound-red-manifest", operationId: effect.operationId }),
		recipeDigest: digestObject({ kind: "unbound-red-recipe", operationId: effect.operationId }),
		planRevision: 1,
		resourceDigest,
	});
	return {
		operationDigest,
		resourceDigest,
		affectedProductionSurface: [path],
		writeSet: [path],
		closureRationale: "host-derived single-file production write",
	};
}

function attemptedIntentRedScope(
	dependencies: WorkflowEffectBrokerDependencies,
	resolution: WorkflowEffectIntentRedScopeResolution,
): WorkflowIntentRedMutationScope {
	assertWorkflowDigest(resolution.operationDigest, "operation");
	assertWorkflowDigest(resolution.resourceDigest, "resource");
	if (resolution.closureRationale.trim().length === 0)
		throw new WorkflowEffectError("workflow_effect_intent_scope_rationale_invalid");
	const affectedProductionSurface = normalizedProductionPathSet(
		dependencies.workspaceRoot,
		resolution.affectedProductionSurface,
		"surface",
	);
	const writeSet = normalizedProductionPathSet(dependencies.workspaceRoot, resolution.writeSet, "write_set");
	const effectDigest = workflowIntentRedMutationEffectDigest({
		resourceDigest: resolution.resourceDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: resolution.closureRationale,
	});
	return {
		operationDigest: resolution.operationDigest,
		resourceDigest: resolution.resourceDigest,
		effectDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: resolution.closureRationale,
	};
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIntentRedScope(left: WorkflowIntentRedMutationScope, right: WorkflowIntentRedMutationScope): boolean {
	return (
		left.operationDigest === right.operationDigest &&
		left.resourceDigest === right.resourceDigest &&
		left.effectDigest === right.effectDigest &&
		left.closureRationale === right.closureRationale &&
		sameStringArray(left.affectedProductionSurface, right.affectedProductionSurface) &&
		sameStringArray(left.writeSet, right.writeSet)
	);
}

function scopeMismatchReason(
	authorized: WorkflowIntentRedMutationScope,
	attempted: WorkflowIntentRedMutationScope,
): "effect" | "operation" | "resource" | "surface" | "write_set" {
	if (authorized.effectDigest !== attempted.effectDigest) return "effect";
	if (authorized.operationDigest !== attempted.operationDigest) return "operation";
	if (authorized.resourceDigest !== attempted.resourceDigest) return "resource";
	if (!sameStringArray(authorized.affectedProductionSurface, attempted.affectedProductionSurface)) return "surface";
	return "write_set";
}

function sameHead(left: WorkflowJournalHead, right: WorkflowJournalHead): boolean {
	return digestObject(left) === digestObject(right);
}

function sameIntentRedAuthorizationScope(
	authorization: WorkflowIntentRedMutationAuthorization,
	attempted: WorkflowIntentRedMutationScope,
): boolean {
	return (
		authorization.operationDigest === attempted.operationDigest &&
		authorization.resourceDigest === attempted.resourceDigest &&
		authorization.effectDigest === attempted.effectDigest &&
		authorization.closureRationale === attempted.closureRationale &&
		sameStringArray(authorization.affectedProductionSurface, attempted.affectedProductionSurface) &&
		sameStringArray(authorization.normalizedWriteClosure, attempted.writeSet) &&
		sameStringArray(authorization.writeSet, attempted.writeSet)
	);
}

function normalizedAuthorizedScope(
	dependencies: WorkflowEffectBrokerDependencies,
	scope: WorkflowIntentRedMutationScope,
): WorkflowIntentRedMutationScope {
	assertWorkflowDigest(scope.operationDigest, "operation");
	assertWorkflowDigest(scope.resourceDigest, "resource");
	if (scope.closureRationale.trim().length === 0)
		throw new WorkflowEffectError("workflow_effect_intent_scope_rationale_invalid");
	const affectedProductionSurface = normalizedProductionPathSet(
		dependencies.workspaceRoot,
		scope.affectedProductionSurface,
		"surface",
	);
	const writeSet = normalizedProductionPathSet(dependencies.workspaceRoot, scope.writeSet, "write_set");
	const effectDigest = workflowIntentRedMutationEffectDigest({
		resourceDigest: scope.resourceDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: scope.closureRationale,
	});
	if (scope.effectDigest !== effectDigest)
		throw new WorkflowEffectError("workflow_effect_intent_scope_effect_digest_invalid");
	return {
		operationDigest: scope.operationDigest,
		resourceDigest: scope.resourceDigest,
		effectDigest,
		affectedProductionSurface,
		writeSet,
		closureRationale: scope.closureRationale,
	};
}

function intentScopeExceededEvent(
	events: readonly { payload: WorkflowEventPayload }[],
	context: WorkflowEffectExecutionContext,
	attemptedScopeDigest: string,
): WorkflowEventPayload | null {
	const event = events.find((candidate) => {
		const payload = candidate.payload as unknown as {
			readonly kind: string;
			readonly attemptId?: string;
			readonly attemptedScopeDigest?: string;
			readonly executionIdentity?: string | null;
		};
		return (
			payload.kind === "intent_scope_exceeded" &&
			payload.attemptId === context.attemptId &&
			payload.attemptedScopeDigest === attemptedScopeDigest &&
			(payload.executionIdentity === null ||
				payload.executionIdentity === undefined ||
				payload.executionIdentity === context.intentRedCurrent?.executionIdentity)
		);
	});
	return event?.payload ?? null;
}

async function quarantineEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	effectDigest: string,
	reason: string,
): Promise<void> {
	await dependencies.leases.quarantine({
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		effectDigest,
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipToken: context.ownershipToken,
		epochRef: context.epochRef,
		store: dependencies.store,
		reason,
	});
}

async function commitIntentScopeExceeded(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	effect: WorkflowConcreteEffect,
	attemptedScope: WorkflowIntentRedMutationScope,
	inspection: WorkflowEffectIntentRedInspection,
	reason: "effect" | "operation" | "resource" | "surface" | "write_set" | "head" | "epoch" | "state" | "revision",
	currentHead: WorkflowJournalHead,
): Promise<never> {
	const current = context.intentRedCurrent;
	if (current === undefined) throw new WorkflowEffectError("intent_red_current_tuple_missing");
	const payload = workflowIntentRedScopeExceededEventPayload({
		manifest: inspection.manifest,
		authorizedScope: inspection.authorizedScope,
		attemptedScope,
		currentHead,
		currentEpoch: context.epochRef,
		currentStateDigest: current.stateDigest,
		currentRevision: current.revision,
		trustedNow: current.trustedNow,
		executionIdentity: current.executionIdentity ?? null,
		sessionId: current.sessionId ?? null,
		reason,
	});
	const payloadDigest = digestObject(payload);
	try {
		await commitWorkflowRuntimeEvent(dependencies.store, {
			workflowId: context.workflowId,
			// The event is owned by the manifest package; the contracts/reducer owner
			// adds its discriminant to the runtime union and validates it on replay.
			payload: payload as unknown as WorkflowRuntimeEventPayload,
			epochRef: context.epochRef,
			leaseRef: context.leaseRef,
			idempotencyKey: `intent-scope-exceeded:${payloadDigest}`,
			writerIdentity: dependencies.writerIdentity,
			executionKey: context.executionKey,
		});
	} catch (error) {
		await quarantineEffect(dependencies, context, digestObject(effect), "intent_scope_exceeded_journal_failed");
		throw new WorkflowEffectError(
			error instanceof Error
				? `intent_scope_exceeded_journal_failed:${error.message}`
				: "intent_scope_exceeded_journal_failed",
		);
	}
	await quarantineEffect(dependencies, context, digestObject(effect), "intent_scope_exceeded");
	try {
		await dependencies.intentRed?.reportDenied?.({
			context,
			effect,
			attemptedScope,
			payloadDigest,
			reason,
		});
	} catch {
		// The durable denial and quarantine remain authoritative if the urgent notification is unavailable.
	}
	throw new WorkflowEffectError("intent_scope_exceeded");
}

interface WorkflowIntentRedAdmission {
	readonly authorization: unknown;
	readonly attemptedScope: WorkflowIntentRedMutationScope;
	readonly decision: WorkflowIntentRedMutationAuthorization;
}

async function admitIntentRedEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	effect: WorkflowConcreteEffect,
	classified: WorkflowClassifiedEffect,
	currentHead: WorkflowJournalHead,
	events: readonly { payload: WorkflowEventPayload }[],
): Promise<WorkflowIntentRedAdmission | null> {
	if (!intentRedRequired(classified)) return null;
	const gateway = dependencies.intentRed;
	if (gateway === undefined) throw new WorkflowEffectError("intent_red_authorizer_unavailable");
	if (context.intentRedAuthorization === undefined || context.intentRedAuthorization === null)
		throw new WorkflowEffectError("intent_red_authorization_missing");
	if (context.intentRedCurrent === undefined) throw new WorkflowEffectError("intent_red_current_tuple_missing");
	let resolution: WorkflowEffectIntentRedScopeResolution;
	let inspection: WorkflowEffectIntentRedInspection;
	try {
		resolution = gateway.resolveScope
			? await gateway.resolveScope({
					authorization: context.intentRedAuthorization,
					context,
					effect,
					classified,
				})
			: defaultIntentRedScope(dependencies, effect, classified);
		inspection = await gateway.inspect({
			authorization: context.intentRedAuthorization,
			context,
			effect,
			classified,
		});
	} catch (error) {
		throw new WorkflowEffectError(
			error instanceof Error
				? `intent_red_authorization_invalid:${error.message}`
				: "intent_red_authorization_invalid",
		);
	}
	const attemptedScope = attemptedIntentRedScope(dependencies, resolution);
	let authorizedScope: WorkflowIntentRedMutationScope;
	try {
		authorizedScope = normalizedAuthorizedScope(dependencies, inspection.authorizedScope);
	} catch (error) {
		throw new WorkflowEffectError(
			error instanceof Error
				? `intent_red_authorized_scope_invalid:${error.message}`
				: "intent_red_authorized_scope_invalid",
		);
	}
	inspection = { ...inspection, authorizedScope };
	if (intentScopeExceededEvent(events, context, workflowIntentRedMutationScopeDigest(attemptedScope)) !== null)
		throw new WorkflowEffectError("intent_scope_exceeded");
	const manifest = inspection.manifest;
	if (
		manifest.workflowId !== context.workflowId ||
		manifest.taskId !== context.taskId ||
		manifest.attemptId !== context.attemptId ||
		manifest.expectedHeadDigest !== digestObject(manifest.expectedHead) ||
		!manifest.tests.some((test) => test.assertions.some((assertion) => assertion.target === "forbidden_outcome"))
	)
		throw new WorkflowEffectError("intent_red_manifest_binding_invalid");
	if (!sameEpoch(manifest.epochRef, context.epochRef))
		return commitIntentScopeExceeded(dependencies, context, effect, attemptedScope, inspection, "epoch", currentHead);
	if (!sameHead(manifest.expectedHead, currentHead))
		return commitIntentScopeExceeded(dependencies, context, effect, attemptedScope, inspection, "head", currentHead);
	if (!sameIntentRedScope(authorizedScope, attemptedScope))
		return commitIntentScopeExceeded(
			dependencies,
			context,
			effect,
			attemptedScope,
			inspection,
			scopeMismatchReason(authorizedScope, attemptedScope),
			currentHead,
		);
	if (
		(attemptedScope.affectedProductionSurface.length > 1 || attemptedScope.writeSet.length > 1) &&
		inspection.adversarialReviewReceiptDigest === undefined
	)
		return commitIntentScopeExceeded(
			dependencies,
			context,
			effect,
			attemptedScope,
			inspection,
			"surface",
			currentHead,
		);
	if (inspection.adversarialReviewReceiptDigest !== undefined)
		assertWorkflowDigest(inspection.adversarialReviewReceiptDigest, "adversarial_review");
	let decision: WorkflowIntentRedMutationAuthorization;
	try {
		decision = await gateway.authorize({
			authorization: context.intentRedAuthorization,
			context,
			effect,
			classified,
			attemptedScope,
			inspection,
			currentHead,
		});
	} catch {
		return commitIntentScopeExceeded(dependencies, context, effect, attemptedScope, inspection, "head", currentHead);
	}
	if (
		!decision.authorized ||
		decision.reason !== "outcome_linked_assertion_failure" ||
		decision.quarantine.reason !== "none" ||
		decision.manifestDigest !== manifest.manifestDigest ||
		!hasNonEmptyString(decision.goalDigest) ||
		!hasNonEmptyString(decision.scorecardDigest) ||
		!hasNonEmptyString(decision.publicBoundaryRegistryDigest) ||
		!Array.isArray(decision.publicBoundaryRegistry) ||
		decision.publicBoundaryRegistry.length === 0 ||
		!Array.isArray(decision.allowedSemanticBehaviorSurface) ||
		decision.allowedSemanticBehaviorSurface.length === 0 ||
		!hasNonEmptyString(decision.evidenceDigest) ||
		!hasNonEmptyString(decision.authorizationDigest) ||
		!hasNonEmptyString(decision.authorityWitness?.receiptId) ||
		!sameIntentRedAuthorizationScope(decision, attemptedScope)
	)
		return commitIntentScopeExceeded(
			dependencies,
			context,
			effect,
			attemptedScope,
			inspection,
			decision.reason === "post_effect" ? "head" : "effect",
			currentHead,
		);
	if (
		decision.productionBaseHeadDigest !== digestObject(currentHead) ||
		decision.baseProductionHeadDigest !== digestObject(currentHead) ||
		decision.productionBaseStateDigest !== context.intentRedCurrent.stateDigest ||
		decision.baseProductionStateDigest !== context.intentRedCurrent.stateDigest ||
		decision.productionBaseRevision !== context.intentRedCurrent.revision ||
		decision.baseProductionRevision !== context.intentRedCurrent.revision ||
		!sameEpoch(decision.productionBaseEpoch, context.epochRef) ||
		!sameEpoch(decision.baseProductionEpoch, context.epochRef) ||
		!sameHead(decision.productionBaseHead, currentHead) ||
		!sameHead(decision.baseProductionHead, currentHead) ||
		decision.lastAdmissibleProductionHeadDigest !== digestObject(currentHead) ||
		(decision.executionIdentity !== null &&
			context.intentRedCurrent.executionIdentity !== undefined &&
			decision.executionIdentity !== context.intentRedCurrent.executionIdentity) ||
		(decision.sessionId !== null &&
			context.intentRedCurrent.sessionId !== undefined &&
			decision.sessionId !== context.intentRedCurrent.sessionId)
	)
		return commitIntentScopeExceeded(dependencies, context, effect, attemptedScope, inspection, "head", currentHead);
	return { authorization: context.intentRedAuthorization, attemptedScope, decision };
}

export function deriveWorkflowEffectIdempotencyKey(
	effect: WorkflowConcreteEffect,
	context: WorkflowEffectExecutionContext,
): string {
	return digestObject({
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		epochRef: context.epochRef,
		decisionRef: context.decisionRef,
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipTokenDigest: context.ownershipToken.tokenDigest,
		idempotencyKey: context.idempotencyKey,
		operationId: effect.operationId,
		effectKind: effect.kind,
		effectDigest: digestObject(effect),
	});
}

async function assertEffectLeaseContext(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	effectDigest: string,
): Promise<void> {
	assertEffectContextShape(context);
	if (dependencies.workflowId !== context.workflowId)
		throw new WorkflowEffectError("workflow_effect_workflow_mismatch");
	const input = {
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		effectDigest,
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
	};
	await dependencies.leases.assertActive(input);
	await dependencies.leases.assertOwnershipToken({ ...input, ownershipToken: context.ownershipToken });
}

function classifyEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	effect: WorkflowConcreteEffect,
	context: WorkflowEffectExecutionContext,
): WorkflowClassifiedEffect {
	assertEffectContextShape(context);
	if (
		typeof effect !== "object" ||
		effect === null ||
		typeof effect.operationId !== "string" ||
		effect.operationId.length === 0
	)
		throw new WorkflowEffectError("workflow_effect_invalid");
	const policy = WORKFLOW_EFFECT_OPERATION_POLICY[effect.kind];
	if (policy === undefined) throw new WorkflowEffectError("workflow_effect_unclassified");
	const host: WorkflowEffectHost =
		effect.kind === "bash_exec"
			? "bash"
			: effect.kind === "file_read" || effect.kind === "file_write"
				? "edit"
				: effect.kind === "ipython_exec"
					? "ipython"
					: effect.kind === "package_manager"
						? "package_manager"
						: effect.kind === "child_process_spawn"
							? "child_process"
							: effect.kind === "artifact_publish"
								? "artifact_publish"
								: "session_mutation";
	const normalizedReadSet =
		effect.kind === "file_read" || effect.kind === "file_write"
			? [normalizedPath(dependencies.workspaceRoot, effect.path, effect.kind === "file_write")]
			: [];
	if (effect.kind === "file_read" && effect.pathDigest !== digestObject(normalizedReadSet[0]))
		throw new WorkflowEffectError("workflow_effect_path_digest_mismatch");
	if (effect.kind === "bash_exec" || effect.kind === "package_manager" || effect.kind === "child_process_spawn")
		normalizedPath(dependencies.workspaceRoot, effect.cwd, false);
	if (effect.kind === "child_process_spawn") {
		normalizedPath(dependencies.workspaceRoot, effect.processGroupRequest.cwd, false);
		try {
			assertWorkflowProcessSpawnDescriptor({
				...effect.processGroupRequest,
				executable: "descriptor-validation",
				arguments: [],
			} as unknown as WorkflowProcessSpawnDescriptor);
		} catch {
			throw new WorkflowEffectError("workflow_spawn_descriptor_invalid");
		}
	}
	const normalizedWriteSet = effect.kind === "file_write" ? normalizedReadSet : [];
	const authority =
		effect.kind === "bash_exec" ||
		effect.kind === "file_write" ||
		effect.kind === "ipython_exec" ||
		effect.kind === "package_manager"
			? effect.kind !== "file_write" && effect.writeClass === "read_only"
				? "read_only"
				: effect.writeClass === "external_write"
					? "external_write"
					: policy.authority
			: policy.authority;
	const requiresUserApproval = policy.requiresUserApproval || authority === "external_write";
	const conflictKeys = [...new Set([...normalizedReadSet, ...normalizedWriteSet])].sort();
	return {
		effect,
		host,
		effectClass: policy.effectClass,
		materiality: policy.materiality,
		derivedMateriality: policy.derivedMateriality,
		authority,
		normalizedReadSet,
		normalizedWriteSet,
		requiresUserApproval,
		idempotencyKey: deriveWorkflowEffectIdempotencyKey(effect, context),
		resourceVector: zeroWorkflowResourceVector(),
		conflictKeys,
	};
}

async function resolveEffectPreimage(
	preimages: WorkflowEffectBrokerDependencies["preimages"],
	ref: WorkflowArtifactRef,
): Promise<WorkflowResolvedEffectPreimage> {
	const resolved = await preimages.resolve(ref);
	if (
		!resolved.immutable ||
		digestObject(resolved.artifactRef) !== digestObject(ref) ||
		resolved.verifiedDigest !== ref.digest ||
		resolved.verifiedSizeBytes !== resolved.bytes.byteLength ||
		resolved.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(resolved.bytes) !== ref.digest ||
		!(["canonical_json", "utf8", "binary"] as const).includes(resolved.codec)
	)
		throw new WorkflowEffectError("workflow_effect_preimage_digest_mismatch");
	return { codec: resolved.codec, bytes: Uint8Array.from(resolved.bytes) };
}

function assertArtifactReference(ref: WorkflowArtifactRef): void {
	if (
		ref.artifactId.length === 0 ||
		ref.relativePath.length === 0 ||
		ref.relativePath.startsWith("/") ||
		ref.relativePath.split("/").some((part) => part === "..") ||
		ref.digest.length === 0 ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	)
		throw new WorkflowEffectError("workflow_effect_artifact_reference_invalid");
}

function assertExecutorResult(input: {
	readonly resultDigest: string;
	readonly evidenceArtifact: WorkflowArtifactRef | null;
}): void {
	if (input.resultDigest.length === 0) throw new WorkflowEffectError("workflow_effect_result_digest_missing");
	if (input.evidenceArtifact !== null) assertArtifactReference(input.evidenceArtifact);
}

function fullEffectResultDigest(
	context: WorkflowEffectExecutionContext,
	classified: WorkflowClassifiedEffect,
	hostResultDigest: string,
): string {
	return digestObject({
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		effectDigest: digestObject(classified.effect),
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipTokenDigest: context.ownershipToken.tokenDigest,
		hostResultDigest,
	});
}

function completedResult(
	context: WorkflowEffectExecutionContext,
	classified: WorkflowClassifiedEffect,
	events: readonly { payload: WorkflowEventPayload; idempotencyKey: string }[],
): WorkflowEffectResult | null {
	const event = completedEvent(events, classified);
	if (
		event === null ||
		event.workflowId !== context.workflowId ||
		event.attemptId !== context.attemptId ||
		event.executionKey !== context.executionKey ||
		!sameEpoch(event.epochRef, context.epochRef)
	)
		return null;
	return { status: "already_completed", resultDigest: event.resultDigest, evidenceArtifact: null };
}

function decodeCanonicalText(bytes: Uint8Array, code: string): string {
	try {
		const value = parseCanonicalJsonBytes(bytes);
		if (typeof value !== "string" || value.length === 0) throw new Error(code);
		return value;
	} catch (error) {
		if (error instanceof WorkflowEffectError) throw error;
		throw new WorkflowEffectError(code);
	}
}

function decodePreimageText(preimage: WorkflowResolvedEffectPreimage, code: string): string {
	if (preimage.codec === "canonical_json") return decodeCanonicalText(preimage.bytes, code);
	try {
		const value = new TextDecoder("utf-8", { fatal: true }).decode(preimage.bytes);
		if (value.length === 0) throw new Error(code);
		return value;
	} catch {
		throw new WorkflowEffectError(code);
	}
}

function decodeArguments(preimage: WorkflowResolvedEffectPreimage): readonly string[] {
	if (preimage.codec !== "canonical_json") {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(preimage.bytes).split("\u0000");
		} catch {
			throw new WorkflowEffectError("workflow_effect_arguments_invalid");
		}
	}
	let value: unknown;
	try {
		value = parseCanonicalJsonBytes(preimage.bytes);
	} catch {
		throw new WorkflowEffectError("workflow_effect_arguments_invalid");
	}
	if (Array.isArray(value) && value.every((argument): argument is string => typeof argument === "string"))
		return value;
	if (typeof value === "string") return value.split("\u0000");
	throw new WorkflowEffectError("workflow_effect_arguments_invalid");
}

function completedEvent(
	events: readonly { payload: WorkflowEventPayload; idempotencyKey: string }[],
	classified: WorkflowClassifiedEffect,
): Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_completed" }> | null {
	const effectDigest = digestObject(classified.effect);
	const event = events.find(
		(candidate) =>
			candidate.payload.kind === "workflow_effect_completed" &&
			candidate.payload.idempotencyKey === classified.idempotencyKey &&
			candidate.payload.effectDigest === effectDigest,
	);
	return event?.payload.kind === "workflow_effect_completed" ? event.payload : null;
}

function intentEvent(
	events: readonly { payload: WorkflowEventPayload; idempotencyKey: string }[],
	classified: WorkflowClassifiedEffect,
): Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_intent" }> | null {
	const event = events.find(
		(candidate) =>
			candidate.payload.kind === "workflow_effect_intent" &&
			candidate.payload.idempotencyKey === classified.idempotencyKey,
	);
	return event?.payload.kind === "workflow_effect_intent" ? event.payload : null;
}

function ambiguousEvent(
	events: readonly { payload: WorkflowEventPayload; idempotencyKey: string }[],
	classified: WorkflowClassifiedEffect,
): Extract<WorkflowRuntimeEventPayload, { kind: "workflow_effect_ambiguous" }> | null {
	const event = events.find(
		(candidate) =>
			candidate.payload.kind === "workflow_effect_ambiguous" &&
			candidate.payload.idempotencyKey === classified.idempotencyKey,
	);
	return event?.payload.kind === "workflow_effect_ambiguous" ? event.payload : null;
}

async function publishAmbiguousEvidence(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	classified: WorkflowClassifiedEffect,
	errorCode: string,
): Promise<WorkflowArtifactRef> {
	const unsigned = {
		kind: "workflow_effect_ambiguous_evidence",
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		revisionBoundary: context.revisionBoundary,
		effectDigest: digestObject(classified.effect),
		idempotencyKey: classified.idempotencyKey,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipTokenDigest: context.ownershipToken.tokenDigest,
		errorCode,
	};
	const signature = await dependencies.evidenceSigner.sign(canonicalJsonBytes(unsigned));
	const bytes = canonicalJsonBytes({ ...unsigned, ...signature });
	const replay = await dependencies.store.replay({
		workflowId: context.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: context.epochRef.storeEpoch,
	});
	const published = await dependencies.store.publishArtifact({
		workflowId: context.workflowId,
		payloadKind: "recovery_finding",
		bytes,
		codec: "canonical_json",
		sourceEventSequence: replay.head.sequence,
		idempotencyKey: `effect-ambiguous-evidence:${classified.idempotencyKey}`,
	});
	assertArtifactReference(published.envelope.ref);
	if (published.envelope.codec !== "canonical_json" || sha256Hex(bytes) !== published.envelope.ref.digest)
		throw new WorkflowEffectError("workflow_effect_evidence_binding_invalid");
	return published.envelope.ref;
}

async function commitAmbiguousEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	classified: WorkflowClassifiedEffect,
	errorCode: string,
	resultStatus: "ambiguous" | "quarantined" = "ambiguous",
): Promise<WorkflowEffectResult> {
	await assertEffectLeaseContext(dependencies, context, digestObject(classified.effect));
	await assertWorkflowProcessRevisionBoundary(
		dependencies,
		context.workflowId,
		context.epochRef,
		context.executionKey,
	);
	await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
	const replay = await dependencies.store.replay({
		workflowId: context.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: context.epochRef.storeEpoch,
	});
	const completed = completedResult(context, classified, replay.events);
	if (completed !== null) return completed;
	const evidenceArtifact = await publishAmbiguousEvidence(dependencies, context, classified, errorCode);
	await assertWorkflowProcessRevisionBoundary(
		dependencies,
		context.workflowId,
		context.epochRef,
		context.executionKey,
	);
	await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
	const afterEvidence = await dependencies.store.replay({
		workflowId: context.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: context.epochRef.storeEpoch,
	});
	const existing = ambiguousEvent(afterEvidence.events, classified);
	if (existing === null) {
		await commitWorkflowRuntimeEvent(dependencies.store, {
			workflowId: context.workflowId,
			payload: {
				kind: "workflow_effect_ambiguous",
				workflowId: context.workflowId,
				attemptId: context.attemptId,
				executionKey: context.executionKey,
				effectDigest: digestObject(classified.effect),
				idempotencyKey: classified.idempotencyKey,
				epochRef: context.epochRef,
				reason:
					errorCode.includes("identity") || errorCode.includes("process")
						? "process_identity_lost"
						: errorCode.includes("completion") || errorCode.includes("stale")
							? "completion_commit_uncertain"
							: "unknown_external_outcome",
			},
			epochRef: context.epochRef,
			leaseRef: context.leaseRef,
			idempotencyKey: `effect-ambiguous:${classified.idempotencyKey}`,
			writerIdentity: dependencies.writerIdentity,
			executionKey: context.executionKey,
		});
	}
	await dependencies.leases.quarantine({
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		effectDigest: digestObject(classified.effect),
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipToken: context.ownershipToken,
		epochRef: context.epochRef,
		store: dependencies.store,
		reason: errorCode,
	});
	return { status: resultStatus, resultDigest: null, evidenceArtifact };
}

async function invokeConcreteEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	classified: WorkflowClassifiedEffect,
	context: WorkflowEffectExecutionContext,
): Promise<WorkflowEffectResult> {
	switch (classified.effect.kind) {
		case "bash_exec": {
			const command = decodePreimageText(
				await resolveEffectPreimage(dependencies.preimages, classified.effect.commandPreimageRef),
				"workflow_effect_command_invalid",
			);
			const result = await dependencies.executors.bash.exec({
				context,
				command,
				cwd: classified.effect.cwd,
				timeoutMs: classified.effect.timeoutMs,
			});
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(context, classified, digestObject({ result })),
				evidenceArtifact: null,
			};
		}
		case "file_read": {
			const bytes = await dependencies.executors.edit.readFile({
				context,
				path: classified.normalizedReadSet[0]!,
			});
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(context, classified, sha256Hex(bytes)),
				evidenceArtifact: null,
			};
		}
		case "file_write": {
			const preimage = await resolveEffectPreimage(dependencies.preimages, classified.effect.contentPreimageRef);
			const content = decodePreimageText(preimage, "workflow_effect_file_content_invalid");
			await dependencies.executors.edit.writeFile({
				context,
				path: classified.normalizedWriteSet[0]!,
				content,
			});
			const readback = await dependencies.executors.edit.readFile({
				context,
				path: classified.normalizedWriteSet[0]!,
			});
			const expectedBytes = new TextEncoder().encode(content);
			if (sha256Hex(readback) !== sha256Hex(expectedBytes))
				throw new WorkflowEffectError("workflow_effect_write_readback_mismatch");
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(
					context,
					classified,
					digestObject({
						contentPreimageRef: classified.effect.contentPreimageRef,
						codec: preimage.codec,
						readbackDigest: sha256Hex(readback),
					}),
				),
				evidenceArtifact: null,
			};
		}
		case "ipython_exec": {
			const code = decodePreimageText(
				await resolveEffectPreimage(dependencies.preimages, classified.effect.codePreimageRef),
				"workflow_effect_ipython_code_invalid",
			);
			const result = await dependencies.executors.ipython.execute({ context, effect: classified.effect, code });
			assertExecutorResult(result);
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(context, classified, result.resultDigest),
				evidenceArtifact: result.evidenceArtifact,
			};
		}
		case "package_manager": {
			const args = decodeArguments(
				await resolveEffectPreimage(dependencies.preimages, classified.effect.argumentsPreimageRef),
			);
			const result = await dependencies.executors.packageManager.execute({
				context,
				effect: classified.effect,
				arguments: args,
			});
			assertExecutorResult(result);
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(context, classified, result.resultDigest),
				evidenceArtifact: result.evidenceArtifact,
			};
		}
		case "artifact_publish": {
			const preimage = await resolveEffectPreimage(dependencies.preimages, classified.effect.payloadPreimageRef);
			const replay = await dependencies.store.replay({
				workflowId: context.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: context.epochRef.storeEpoch,
			});
			const artifact = await dependencies.store.publishArtifact({
				workflowId: context.workflowId,
				payloadKind: classified.effect.payloadKind,
				bytes: preimage.bytes,
				codec: preimage.codec,
				sourceEventSequence: replay.head.sequence,
				idempotencyKey: classified.idempotencyKey,
			});
			assertArtifactReference(artifact.envelope.ref);
			if (
				artifact.envelope.codec !== preimage.codec ||
				artifact.envelope.ref.digest !== sha256Hex(preimage.bytes) ||
				artifact.envelope.ref.sizeBytes !== preimage.bytes.byteLength
			)
				throw new WorkflowEffectError("workflow_effect_artifact_binding_invalid");
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(
					context,
					classified,
					digestObject({ artifactRef: artifact.envelope.ref, codec: artifact.envelope.codec }),
				),
				evidenceArtifact: artifact.envelope.ref,
			};
		}
		case "session_mutation": {
			const preimage = await resolveEffectPreimage(dependencies.preimages, classified.effect.mutationPreimageRef);
			const result = await dependencies.executors.session.mutate({
				context,
				effect: classified.effect,
				bytes: preimage.bytes,
			});
			assertExecutorResult(result);
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(context, classified, result.resultDigest),
				evidenceArtifact: result.evidenceArtifact,
			};
		}
		case "child_process_spawn": {
			const executable = decodePreimageText(
				await resolveEffectPreimage(dependencies.preimages, classified.effect.executablePreimageRef),
				"workflow_child_process_executable_invalid",
			);
			const args = decodeArguments(
				await resolveEffectPreimage(dependencies.preimages, classified.effect.argumentsPreimageRef),
			);
			const request = classified.effect.processGroupRequest;
			const descriptor = {
				...request,
				executable,
				arguments: args,
			} as unknown as WorkflowProcessSpawnDescriptor;
			try {
				assertWorkflowProcessSpawnDescriptor(descriptor);
			} catch {
				throw new WorkflowEffectError("workflow_spawn_descriptor_invalid");
			}
			const result = await dependencies.executors.childProcess.spawn({
				context,
				effect: classified.effect,
				executable,
				arguments: args,
				processGroupRequest: descriptor,
			});
			if (
				result.binding.workflowId !== context.workflowId ||
				result.binding.taskId !== context.taskId ||
				result.binding.attemptId !== context.attemptId ||
				result.binding.childIdentity.executionKey !== context.executionKey ||
				!sameEpoch(result.binding.childIdentity.epochRef, context.epochRef) ||
				result.binding.processGroup.identityDigest !==
					canonicalWorkflowProcessGroupDigest({
						pid: result.binding.processGroup.pid,
						processStartId: result.binding.processGroup.processStartId,
						processGroupId: result.binding.processGroup.processGroupId,
						parentPid: result.binding.processGroup.parentPid,
					}) ||
				result.binding.childIdentity.identityDigest !==
					canonicalWorkflowIdentityDigest({
						admissionId: result.binding.childIdentity.admissionId,
						childSessionId: result.binding.childIdentity.childSessionId,
						executionKey: result.binding.childIdentity.executionKey,
						epochRef: result.binding.childIdentity.epochRef,
						runtimeVersion: result.binding.childIdentity.runtimeVersion,
						hostCapabilityRevision: result.binding.childIdentity.hostCapabilityRevision,
						agentRole: result.binding.childIdentity.agentRole,
						modelId: result.binding.childIdentity.modelId,
						reasoningEffort: result.binding.childIdentity.reasoningEffort,
						launchConfigDigest: result.binding.childIdentity.launchConfigDigest,
						processGroupId: result.binding.childIdentity.processGroupId,
					}) ||
				result.binding.bindingDigest !==
					canonicalWorkflowBindingDigest({
						childIdentity: result.binding.childIdentity,
						processGroup: result.binding.processGroup,
					}) ||
				result.resultDigest.length === 0
			)
				throw new WorkflowEffectError("workflow_child_process_binding_invalid");
			return {
				status: "completed",
				resultDigest: fullEffectResultDigest(
					context,
					classified,
					digestObject({ binding: result.binding, hostResultDigest: result.resultDigest }),
				),
				evidenceArtifact: null,
			};
		}
	}
}

async function commitEffectCompletion(
	dependencies: WorkflowEffectBrokerDependencies,
	context: WorkflowEffectExecutionContext,
	classified: WorkflowClassifiedEffect,
	result: WorkflowEffectResult,
): Promise<WorkflowEffectResult> {
	await assertEffectLeaseContext(dependencies, context, digestObject(classified.effect));
	await assertWorkflowProcessRevisionBoundary(
		dependencies,
		context.workflowId,
		context.epochRef,
		context.executionKey,
	);
	await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
	const committed = await commitWorkflowRuntimeEvent(dependencies.store, {
		workflowId: context.workflowId,
		payload: {
			kind: "workflow_effect_completed",
			workflowId: context.workflowId,
			attemptId: context.attemptId,
			executionKey: context.executionKey,
			effectDigest: digestObject(classified.effect),
			resultDigest: result.resultDigest ?? digestObject(result),
			idempotencyKey: classified.idempotencyKey,
			epochRef: context.epochRef,
			disposition: "completed",
		},
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		idempotencyKey: `effect-completed:${classified.idempotencyKey}`,
		writerIdentity: dependencies.writerIdentity,
		executionKey: context.executionKey,
	});
	if (committed.status === "already_committed") {
		const replay = await dependencies.store.replay({
			workflowId: context.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: context.epochRef.storeEpoch,
		});
		const persisted = completedResult(context, classified, replay.events);
		if (persisted === null) throw new WorkflowEffectError("workflow_effect_completion_replay_missing");
		return persisted;
	}
	return {
		...result,
		status: "completed",
		resultDigest: result.resultDigest ?? digestObject(result),
	};
}

async function executeWorkflowEffectUnlocked(
	dependencies: WorkflowEffectBrokerDependencies,
	broker: WorkflowEffectBroker,
	effect: WorkflowConcreteEffect,
	context: WorkflowEffectExecutionContext,
): Promise<WorkflowEffectResult> {
	await assertEffectLeaseContext(dependencies, context, digestObject(effect));
	await assertWorkflowProcessRevisionBoundary(
		dependencies,
		context.workflowId,
		context.epochRef,
		context.executionKey,
	);
	await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
	const classified = broker.classify(effect, context);
	const decision = classified.requiresUserApproval
		? await dependencies.decisionVerifier.verify({ context, effect })
		: "not_required";
	if (
		classified.requiresUserApproval &&
		(decision !== "approved" ||
			!(await dependencies.approvalProof.verifyAndConsume({
				context,
				effect,
				decision,
				response: context.approvalResponse,
			})))
	)
		return commitAmbiguousEffect(
			dependencies,
			context,
			classified,
			"workflow_effect_approval_rejected",
			"quarantined",
		);

	const before = await dependencies.store.replay({
		workflowId: context.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: context.epochRef.storeEpoch,
	});
	const completed = completedResult(context, classified, before.events);
	if (completed !== null) return completed;
	if (ambiguousEvent(before.events, classified) !== null)
		return commitAmbiguousEffect(dependencies, context, classified, "workflow_effect_already_ambiguous");
	if (intentEvent(before.events, classified) !== null)
		return commitAmbiguousEffect(dependencies, context, classified, "workflow_effect_completion_missing");
	if (dependencies.producerSealFence !== undefined && classified.effect.kind !== "file_read") {
		try {
			await dependencies.producerSealFence.assertEffectAllowed({
				context,
				effect,
				classified,
				writeSet: classified.normalizedWriteSet,
			});
		} catch (error) {
			await quarantineEffect(dependencies, context, digestObject(classified.effect), "producer_write_fenced");
			throw new WorkflowEffectError(
				error instanceof Error ? `producer_write_fenced:${error.message}` : "producer_write_fenced",
			);
		}
	}
	const intentAdmission = await admitIntentRedEffect(
		dependencies,
		context,
		effect,
		classified,
		before.head,
		before.events,
	);

	try {
		const intentCommit = await commitWorkflowRuntimeEvent(dependencies.store, {
			workflowId: context.workflowId,
			payload: {
				kind: "workflow_effect_intent",
				workflowId: context.workflowId,
				attemptId: context.attemptId,
				executionKey: context.executionKey,
				effectDigest: digestObject(classified.effect),
				decisionRef: context.decisionRef,
				epochRef: context.epochRef,
				idempotencyKey: classified.idempotencyKey,
				effect: classified.effect,
			},
			epochRef: context.epochRef,
			leaseRef: context.leaseRef,
			idempotencyKey: classified.idempotencyKey,
			writerIdentity: dependencies.writerIdentity,
			executionKey: context.executionKey,
		});
		if (intentCommit.status === "already_committed") {
			const afterIntent = await dependencies.store.replay({
				workflowId: context.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: context.epochRef.storeEpoch,
			});
			const completedAfterIntent = completedResult(context, classified, afterIntent.events);
			if (completedAfterIntent !== null) return completedAfterIntent;
			if (ambiguousEvent(afterIntent.events, classified) !== null)
				return commitAmbiguousEffect(dependencies, context, classified, "workflow_effect_already_ambiguous");
			return commitAmbiguousEffect(dependencies, context, classified, "workflow_effect_intent_commit_uncertain");
		}
	} catch (error) {
		return commitAmbiguousEffect(
			dependencies,
			context,
			classified,
			error instanceof Error ? error.message : "workflow_effect_intent_commit_uncertain",
		);
	}

	try {
		await assertEffectLeaseContext(dependencies, context, digestObject(classified.effect));
		await assertWorkflowProcessRevisionBoundary(
			dependencies,
			context.workflowId,
			context.epochRef,
			context.executionKey,
		);
		await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
		const result = await invokeConcreteEffect(dependencies, classified, context);
		if (dependencies.producerSealFence?.verifyPostEffect !== undefined && classified.effect.kind !== "file_read")
			await dependencies.producerSealFence.verifyPostEffect({
				context,
				effect,
				classified,
				writeSet: classified.normalizedWriteSet,
			});
		if (dependencies.intentRed?.verifyPostEffect !== undefined && intentAdmission !== null)
			await dependencies.intentRed.verifyPostEffect({
				authorization: intentAdmission.decision,
				context,
				effect,
				classified,
				attemptedScope: intentAdmission.attemptedScope,
			});
		await assertEffectLeaseContext(dependencies, context, digestObject(classified.effect));
		await assertWorkflowProcessRevisionBoundary(
			dependencies,
			context.workflowId,
			context.epochRef,
			context.executionKey,
		);
		await dependencies.epochs.assertCurrent(context.workflowId, context.epochRef);
		return await commitEffectCompletion(dependencies, context, classified, result);
	} catch (error) {
		const errorCode = error instanceof Error ? error.message : "workflow_effect_ambiguous";
		return commitAmbiguousEffect(
			dependencies,
			context,
			classified,
			errorCode,
			errorCode.startsWith("producer_write_fenced") || errorCode.startsWith("intent_scope_exceeded")
				? "quarantined"
				: "ambiguous",
		);
	}
}

const inFlightWorkflowEffects = new Map<string, Promise<WorkflowEffectResult>>();

export function executeWorkflowEffect(
	dependencies: WorkflowEffectBrokerDependencies,
	broker: WorkflowEffectBroker,
	effect: WorkflowConcreteEffect,
	context: WorkflowEffectExecutionContext,
): Promise<WorkflowEffectResult> {
	const lockKey = digestObject({
		workflowId: context.workflowId,
		taskId: context.taskId,
		attemptId: context.attemptId,
		executionKey: context.executionKey,
		effectDigest: digestObject(effect),
		epochRef: context.epochRef,
		leaseRef: context.leaseRef,
		resourceLeaseRef: context.resourceLeaseRef,
		ownershipLeaseRef: context.ownershipLeaseRef,
		ownershipTokenDigest: context.ownershipToken.tokenDigest,
	});
	const previous = inFlightWorkflowEffects.get(lockKey) ?? Promise.resolve(undefined);
	const current = previous
		.catch(() => undefined)
		.then(() => executeWorkflowEffectUnlocked(dependencies, broker, effect, context));
	const tracked = current.finally(() => {
		if (inFlightWorkflowEffects.get(lockKey) === tracked) inFlightWorkflowEffects.delete(lockKey);
	});
	inFlightWorkflowEffects.set(lockKey, tracked);
	return tracked;
}

class DurableWorkflowEffectBroker implements WorkflowEffectBroker {
	constructor(private readonly dependencies: WorkflowEffectBrokerDependencies) {}

	classify(effect: WorkflowConcreteEffect, context: WorkflowEffectExecutionContext): WorkflowClassifiedEffect {
		validateWorkflowEffectHookRegistry(this.dependencies.hookRegistry);
		return classifyEffect(this.dependencies, effect, context);
	}

	execute(effect: WorkflowConcreteEffect, context: WorkflowEffectExecutionContext): Promise<WorkflowEffectResult> {
		return executeWorkflowEffect(this.dependencies, this, effect, context);
	}

	async reconcile(
		effect: WorkflowConcreteEffect,
		idempotencyKey: string,
		epochRef: WorkflowEpochRef,
		context?: WorkflowEffectExecutionContext,
	): Promise<WorkflowEffectResult> {
		if (context === undefined) throw new WorkflowEffectError("workflow_effect_reconciliation_context_missing");
		if (!sameEpoch(context.epochRef, epochRef))
			throw new WorkflowEffectError("workflow_effect_reconciliation_epoch_mismatch");
		await assertEffectLeaseContext(this.dependencies, context, digestObject(effect));
		const classified = this.classify(effect, context);
		if (classified.idempotencyKey !== idempotencyKey)
			throw new WorkflowEffectError("workflow_effect_reconciliation_key_mismatch");
		await assertWorkflowProcessRevisionBoundary(
			this.dependencies,
			context.workflowId,
			epochRef,
			context.executionKey,
		);
		const replay = await this.dependencies.store.replay({
			workflowId: context.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: epochRef.storeEpoch,
		});
		const completed = replay.events.find(
			(event) =>
				event.workflowId === context.workflowId &&
				sameLease(event.leaseRef, context.leaseRef) &&
				event.payload.kind === "workflow_effect_completed" &&
				event.payload.idempotencyKey === idempotencyKey &&
				event.payload.effectDigest === digestObject(effect) &&
				event.payload.attemptId === context.attemptId &&
				event.payload.executionKey === context.executionKey &&
				sameEpoch(event.payload.epochRef, context.epochRef),
		);
		if (completed?.payload.kind === "workflow_effect_completed")
			return { status: "already_completed", resultDigest: completed.payload.resultDigest, evidenceArtifact: null };
		const ambiguous = replay.events.find(
			(event) =>
				event.workflowId === context.workflowId &&
				sameLease(event.leaseRef, context.leaseRef) &&
				event.payload.kind === "workflow_effect_ambiguous" &&
				event.payload.idempotencyKey === idempotencyKey &&
				event.payload.effectDigest === digestObject(effect) &&
				event.payload.attemptId === context.attemptId &&
				event.payload.executionKey === context.executionKey &&
				sameEpoch(event.payload.epochRef, context.epochRef),
		);
		if (ambiguous !== undefined) return { status: "ambiguous", resultDigest: null, evidenceArtifact: null };
		const intent = replay.events.find(
			(event) =>
				event.workflowId === context.workflowId &&
				sameLease(event.leaseRef, context.leaseRef) &&
				event.payload.kind === "workflow_effect_intent" &&
				event.payload.idempotencyKey === idempotencyKey &&
				event.payload.effectDigest === digestObject(effect) &&
				event.payload.attemptId === context.attemptId &&
				event.payload.executionKey === context.executionKey &&
				sameEpoch(event.payload.epochRef, context.epochRef),
		);
		return intent === undefined
			? { status: "quarantined", resultDigest: null, evidenceArtifact: null }
			: { status: "ambiguous", resultDigest: null, evidenceArtifact: null };
	}

	readiness(): { canExecute: boolean; blockingReasons: readonly string[] } {
		try {
			validateWorkflowEffectHookRegistry(this.dependencies.hookRegistry);
		} catch {
			return { canExecute: false, blockingReasons: ["effect_hook_unbrokered"] };
		}
		const available =
			this.dependencies.store !== undefined &&
			this.dependencies.epochs !== undefined &&
			this.dependencies.leases !== undefined &&
			this.dependencies.groups !== undefined &&
			this.dependencies.executors !== undefined &&
			this.dependencies.preimages !== undefined &&
			this.dependencies.decisionVerifier !== undefined &&
			this.dependencies.approvalProof !== undefined &&
			this.dependencies.evidenceSigner !== undefined;
		return available
			? { canExecute: true, blockingReasons: [] }
			: { canExecute: false, blockingReasons: ["effect_hook_unbrokered"] };
	}
}

export function createWorkflowEffectBroker(dependencies: WorkflowEffectBrokerDependencies): WorkflowEffectBroker {
	return new DurableWorkflowEffectBroker(dependencies);
}
