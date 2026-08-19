import {
	canonicalJsonBytes,
	type DurableDecisionKind,
	type DurableDecisionRecord,
	type DurableDecisionStage,
	type DurableEffectClass,
	type DurableHostAdjudication,
	type DurableHostDecisionClassification,
	type DurableLensRole,
	type DurableMateriality,
	type DurableStageVerdict,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowAuthorityCapability,
	type WorkflowConcreteEffect,
	type WorkflowDecisionRecord,
	type WorkflowEffectPreimage,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";

const REQUIRED_STAGES: readonly DurableDecisionStage[] = [
	"recon",
	"lens",
	"lens",
	"verification",
	"synthesis",
	"red_team",
];
const REQUIRED_LENS_ROLES: readonly (DurableLensRole | null)[] = [null, "primary", "secondary", null, null, null];
const MAX_DECISION_TTL_MILLISECONDS = 86_400_000;
const CONSEQUENTIAL_OPERATION_KINDS = new Set<DurableDecisionKind>(["configuration_revision", "profile_selection"]);

type WorkflowSessionMutationTarget = Extract<WorkflowConcreteEffect, { kind: "session_mutation" }>["target"];

const DECISION_EFFECT_BINDINGS = {
	goal_binding: { kind: "session_mutation", target: "goal" },
	goal_transition: { kind: "session_mutation", target: "goal" },
	goal_contract: { kind: "session_mutation", target: "goal" },
	scorecard: { kind: "session_mutation", target: "session_projection" },
	resource_envelope: { kind: "session_mutation", target: "session_projection" },
	configuration_revision: { kind: "session_mutation", target: "settings" },
	profile_selection: { kind: "session_mutation", target: "settings" },
	plan: { kind: "session_mutation", target: "session_projection" },
	ownership: { kind: "session_mutation", target: "session_projection" },
	strategy_change: { kind: "session_mutation", target: "session_projection" },
	progress_acceptance: { kind: "session_mutation", target: "session_projection" },
	blocker: { kind: "session_mutation", target: "session_projection" },
	recovery: { kind: "session_mutation", target: "session_projection" },
	skill_gate: { kind: "session_mutation", target: "session_projection" },
	autoresearch_candidate: { kind: "session_mutation", target: "session_projection" },
	refinement: { kind: "session_mutation", target: "session_projection" },
	memory_write: { kind: "session_mutation", target: "session_projection" },
	completion: { kind: "session_mutation", target: "goal" },
	cancellation: { kind: "session_mutation", target: "goal" },
} as const satisfies Readonly<
	Record<DurableDecisionKind, { kind: WorkflowConcreteEffect["kind"]; target: WorkflowSessionMutationTarget }>
>;

const WORKFLOW_DECISION_KINDS = new Set<DurableDecisionKind>([
	"goal_binding",
	"goal_transition",
	"goal_contract",
	"scorecard",
	"resource_envelope",
	"configuration_revision",
	"profile_selection",
	"plan",
	"ownership",
	"strategy_change",
	"progress_acceptance",
	"blocker",
	"recovery",
	"skill_gate",
	"autoresearch_candidate",
	"refinement",
	"memory_write",
	"completion",
	"cancellation",
]);

const WORKFLOW_AUTHORITY_CAPABILITIES = new Set<WorkflowAuthorityCapability>([
	"observe_workflow",
	"read_workspace",
	"read_external_evidence",
	"propose_transition",
	"write_owned_paths",
	"spawn_child",
	"consume_resource_lease",
	"invoke_host_effect",
	"request_user_approval",
	"apply_goal_projection",
	"accept_progress",
	"accept_completion",
	"write_canonical_knowledge",
]);

const WORKFLOW_EFFECT_CLASSES = new Set<DurableEffectClass>([
	"read_only",
	"owned_reversible_local_write",
	"public_interface",
	"test_or_evaluator",
	"dependency_or_lockfile",
	"configuration",
	"goal_contract_or_scorecard",
	"authority_or_resource",
	"git_or_publication",
	"external_side_effect",
	"destructive_or_irreversible",
	"unknown",
]);

export interface WorkflowTypedOperation {
	schemaVersion: 1;
	kind: DurableDecisionKind;
	targetDigest: string;
	effectDigest: string;
	preconditionDigest: string;
	readSet: readonly string[];
	writeSet: readonly string[];
	effectFacts: {
		contractMutation: boolean;
		authorityMutation: boolean;
		resourceEnvelopeMutation: boolean;
		externalSideEffect: boolean;
		destructiveOrIrreversible: boolean;
		localWrite: boolean;
	};
}

export interface WorkflowOperation {
	kind: DurableDecisionKind;
	preimageRef: WorkflowArtifactRef;
	preimageDigest: string;
}

export interface WorkflowOperationHost {
	create(kind: DurableDecisionKind, targetDigest: string, inputStateDigest: string): Promise<WorkflowOperation>;
	resolve(operation: WorkflowOperation): Promise<{ typed: WorkflowTypedOperation; preimage: WorkflowEffectPreimage }>;
}

export interface WorkflowDecisionContext {
	stateDigest: string;
	objectiveDigest: string;
	contractDigest: string;
	scorecardDigest: string;
	planDigest: string;
	workspaceDigest: string;
	evidenceDigest: string;
	parserDigest: string;
	evaluatorDigest: string;
	guardDigest: string;
	regressionDigest: string;
	blockerDigest: string | null;
	redTeamDigest: string;
	executionKey: string;
	currentRevision: number;
	configDigest: string;
	profileDigest: string;
	revisionRegistryDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	now: string;
	overlappingWriteSets: readonly (readonly string[])[];
}

export interface WorkflowDecisionHostObservation {
	context: WorkflowDecisionContext;
	trustedNow: string;
	revisionsDigest: string;
	requiredCapabilities: readonly WorkflowAuthorityCapability[];
	currentDecision: WorkflowDecisionRecord;
}

export interface WorkflowStageObservation {
	outputArtifactRefs: readonly WorkflowArtifactRef[];
	outputDigest: string;
	evidenceDigest: string;
	executionIdentity: string;
	sessionId: string;
}

export interface WorkflowDecisionHost {
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	observe(input: {
		workflowId: string;
		decisionId: string;
		operation: WorkflowOperation;
	}): Promise<WorkflowDecisionHostObservation>;
	current(input: { workflowId: string; decisionId: string }): Promise<WorkflowDecisionHostObservation>;
	resolveOperation(
		operation: WorkflowOperation,
	): Promise<{ typed: WorkflowTypedOperation; preimage: WorkflowEffectPreimage }>;
	issueStageExecutionIdentity(input: {
		decisionId: string;
		revision: number;
		attemptToken: string;
		nonce: string;
		executionKey: string;
		bindingDigest: string;
		stage: DurableDecisionStage;
		lensRole: DurableLensRole | null;
		epochRef: WorkflowEpochRef;
	}): Promise<{ executionIdentity: string; sessionId: string; bindingDigest: string }>;
	resolveStageOutput(input: {
		decisionId: string;
		revision: number;
		attemptToken: string;
		nonce: string;
		executionKey: string;
		bindingDigest: string;
		operationDigest: string;
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		stage: DurableDecisionStage;
		lensRole: DurableLensRole | null;
		executionIdentity: string;
		sessionId: string;
		charterDigest: string;
		observation: WorkflowStageObservation;
	}): Promise<DurableStageVerdict>;
	issueAdjudicationReceipt(input: {
		workflowId: string;
		decisionId: string;
		decisionRevision: number;
		attemptToken: string;
		nonce: string;
		executionKey: string;
		operationDigest: string;
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		executionIdentity: string;
		sessionId: string;
		verdictArtifactRef: WorkflowArtifactRef;
		verdictDigest: string;
		bindingDigest: string;
		validUntil: string;
	}): Promise<WorkflowVerifiedHostReceipt>;
}

export interface WorkflowWriteSetReservation {
	reservationId: string;
	decisionId: string;
	revision: number;
	normalizedPaths: readonly string[];
	reservationDigest: string;
	expectedHeadDigest: string;
	status: "held" | "released";
}

export interface WorkflowWriteSetReservationStore {
	reserve(input: {
		workflowId: string;
		decisionId: string;
		revision: number;
		normalizedPaths: readonly string[];
		expectedHeadDigest: string;
		epochRef: WorkflowEpochRef;
	}): Promise<WorkflowWriteSetReservation>;
	assertHeld(input: {
		reservation: WorkflowWriteSetReservation;
		decisionId: string;
		revision: number;
		epochRef: WorkflowEpochRef;
	}): Promise<void>;
	release(input: { reservation: WorkflowWriteSetReservation; epochRef: WorkflowEpochRef }): Promise<void>;
}

export interface WorkflowFreshGateFence {
	claim(input: {
		workflowId: string;
		decisionId: string;
		revision: number;
		expectedDisposition: "proposed";
		attemptToken: string;
		nonce: string;
		executionKey: string;
		operationDigest: string;
		epochRef: WorkflowEpochRef;
		boundaryDigest: string;
	}): Promise<"claimed" | "already_claimed">;
}

export interface WorkflowImmutableGateToken {
	kind: "immutable_gate_token";
	operation: WorkflowOperation;
	resolvedOperationDigest: string;
	tokenDigest: string;
	stagePlanDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	expiresAt: string;
}

export type WorkflowAuthorizationInput = WorkflowOperation | WorkflowImmutableGateToken;

export interface WorkflowDecisionGate {
	classify(operation: WorkflowOperation): Promise<DurableHostDecisionClassification>;
	validateVerdicts(record: WorkflowDecisionRecord): Promise<void>;
	authorize(
		record: WorkflowDecisionRecord,
		input: WorkflowAuthorizationInput,
	): Promise<"authorized" | "awaiting_user" | "rejected" | "conflicted">;
	runFreshSixStageGate(
		decision: WorkflowDecisionRecord,
		operation: WorkflowOperation,
		inputStateDigest: string,
		runner: FreshStageRunner,
	): Promise<WorkflowDecisionRecord>;
}

export interface FreshStageInput {
	decision: WorkflowDecisionRecord;
	stage: DurableDecisionStage;
	lensRole: DurableLensRole | null;
	inputStateDigest: string;
	charterDigest: string;
	priorVerdicts: readonly DurableStageVerdict[];
	hostExecutionIdentity: string;
	hostSessionId: string;
}

export interface FreshStageRunner {
	run(input: FreshStageInput): Promise<WorkflowStageObservation>;
}

class WorkflowDecisionConflictError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafeEpoch(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function bytesEqual(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return (
		left.artifactId === right.artifactId &&
		left.relativePath === right.relativePath &&
		left.digest === right.digest &&
		left.sizeBytes === right.sizeBytes &&
		left.sourceEventSequence === right.sourceEventSequence
	);
}

function assertArtifactRef(value: unknown, label: string): asserts value is WorkflowArtifactRef {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.artifactId) ||
		!isNonEmptyString(value.relativePath) ||
		!isNonEmptyString(value.digest) ||
		typeof value.sizeBytes !== "number" ||
		!Number.isSafeInteger(value.sizeBytes) ||
		value.sizeBytes < 0 ||
		typeof value.sourceEventSequence !== "number" ||
		!Number.isSafeInteger(value.sourceEventSequence) ||
		value.sourceEventSequence < 0
	) {
		throw new Error(`${label} is not a valid artifact reference.`);
	}
}

function normalizePath(value: string): string {
	const normalized = value.trim().replaceAll("\\", "/");
	const parts = normalized.split("/");
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		parts.some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new Error("Workflow write-set path is not canonical.");
	}
	return parts.join("/");
}

function normalizePathSet(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => normalizePath(value)))].sort();
}

function isPathPrefix(prefix: string, value: string): boolean {
	const prefixParts = normalizePath(prefix).split("/");
	const valueParts = normalizePath(value).split("/");
	return prefixParts.length <= valueParts.length && prefixParts.every((part, index) => part === valueParts[index]);
}

function assertNoOverlappingWrites(left: readonly string[], right: readonly string[]): void {
	const normalizedLeft = normalizePathSet(left);
	const normalizedRight = normalizePathSet(right);
	if (
		normalizedLeft.some((first) =>
			normalizedRight.some((second) => isPathPrefix(first, second) || isPathPrefix(second, first)),
		)
	) {
		throw new WorkflowDecisionConflictError("Overlapping write-set prefixes require a new decision revision.");
	}
}

function isExactArtifactRefValue(value: unknown): value is WorkflowArtifactRef {
	if (!isRecord(value)) return false;
	const artifactRefKeys = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"];
	return (
		Object.keys(value).sort().join("|") === artifactRefKeys.sort().join("|") &&
		isNonEmptyString(value.artifactId) &&
		isNonEmptyString(value.relativePath) &&
		isNonEmptyString(value.digest) &&
		typeof value.sizeBytes === "number" &&
		Number.isSafeInteger(value.sizeBytes) &&
		value.sizeBytes >= 0 &&
		typeof value.sourceEventSequence === "number" &&
		Number.isSafeInteger(value.sourceEventSequence) &&
		value.sourceEventSequence >= 0
	);
}

function isCanonicalEffectPath(value: unknown): value is string {
	if (!isNonEmptyString(value)) return false;
	try {
		return normalizePath(value) === value;
	} catch {
		return false;
	}
}

function isConcreteWriteClass(value: unknown): value is "read_only" | "workspace_write" | "external_write" {
	return value === "read_only" || value === "workspace_write" || value === "external_write";
}

function isConcreteMutationWriteClass(value: unknown): value is "workspace_write" | "external_write" {
	return value === "workspace_write" || value === "external_write";
}

function isConcreteProcessSpawnRequest(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.keys(value).sort().join("|") ===
			["arguments", "cwd", "detached", "executable", "requireProcessStartId"].sort().join("|") &&
		isNonEmptyString(value.executable) &&
		Array.isArray(value.arguments) &&
		value.arguments.every((argument) => typeof argument === "string") &&
		isCanonicalEffectPath(value.cwd) &&
		typeof value.detached === "boolean" &&
		typeof value.requireProcessStartId === "boolean"
	);
}

function isConcreteEffectValue(value: unknown): value is WorkflowConcreteEffect {
	if (!isRecord(value) || !isNonEmptyString(value.kind) || !isNonEmptyString(value.operationId)) return false;
	if (value.kind === "bash_exec") {
		return (
			Object.keys(value).sort().join("|") ===
				["commandPreimageRef", "cwd", "kind", "operationId", "timeoutMs", "writeClass"].sort().join("|") &&
			isExactArtifactRefValue(value.commandPreimageRef) &&
			isCanonicalEffectPath(value.cwd) &&
			typeof value.timeoutMs === "number" &&
			Number.isSafeInteger(value.timeoutMs) &&
			value.timeoutMs > 0 &&
			isConcreteWriteClass(value.writeClass)
		);
	}
	if (value.kind === "file_read") {
		return (
			Object.keys(value).sort().join("|") === ["kind", "operationId", "path", "pathDigest"].sort().join("|") &&
			isCanonicalEffectPath(value.path) &&
			isNonEmptyString(value.pathDigest)
		);
	}
	if (value.kind === "file_write") {
		return (
			Object.keys(value).sort().join("|") ===
				["contentPreimageRef", "kind", "operationId", "path", "writeClass"].sort().join("|") &&
			isCanonicalEffectPath(value.path) &&
			isExactArtifactRefValue(value.contentPreimageRef) &&
			isConcreteMutationWriteClass(value.writeClass)
		);
	}
	if (value.kind === "ipython_exec") {
		return (
			Object.keys(value).sort().join("|") ===
				["codePreimageRef", "kind", "kernelId", "operationId", "writeClass"].sort().join("|") &&
			isExactArtifactRefValue(value.codePreimageRef) &&
			isNonEmptyString(value.kernelId) &&
			isConcreteWriteClass(value.writeClass)
		);
	}
	if (value.kind === "package_manager") {
		return (
			Object.keys(value).sort().join("|") ===
				["argumentsPreimageRef", "cwd", "kind", "manager", "operationId", "writeClass"].sort().join("|") &&
			isExactArtifactRefValue(value.argumentsPreimageRef) &&
			isCanonicalEffectPath(value.cwd) &&
			["npm", "pnpm", "yarn", "pip", "uv"].includes(value.manager as string) &&
			isConcreteMutationWriteClass(value.writeClass)
		);
	}
	if (value.kind === "child_process_spawn") {
		return (
			Object.keys(value).sort().join("|") ===
				["argumentsPreimageRef", "cwd", "executablePreimageRef", "kind", "operationId", "processGroupRequest"]
					.sort()
					.join("|") &&
			isExactArtifactRefValue(value.executablePreimageRef) &&
			isExactArtifactRefValue(value.argumentsPreimageRef) &&
			isCanonicalEffectPath(value.cwd) &&
			isConcreteProcessSpawnRequest(value.processGroupRequest)
		);
	}
	if (value.kind === "artifact_publish") {
		return (
			Object.keys(value).sort().join("|") ===
				["kind", "operationId", "payloadKind", "payloadPreimageRef"].sort().join("|") &&
			isExactArtifactRefValue(value.payloadPreimageRef) &&
			["handoff", "evidence", "process_identity", "effect_result", "recovery_finding", "barrier"].includes(
				value.payloadKind as string,
			)
		);
	}
	return (
		value.kind === "session_mutation" &&
		Object.keys(value).sort().join("|") ===
			["kind", "mutationPreimageRef", "operationId", "target"].sort().join("|") &&
		isExactArtifactRefValue(value.mutationPreimageRef) &&
		["goal", "settings", "session_projection"].includes(value.target as string)
	);
}

function isExactWorkflowTypedOperation(value: unknown): value is WorkflowTypedOperation {
	if (!isRecord(value)) return false;
	const operationKeys = [
		"effectDigest",
		"effectFacts",
		"kind",
		"preconditionDigest",
		"readSet",
		"schemaVersion",
		"targetDigest",
		"writeSet",
	];
	if (Object.keys(value).sort().join("|") !== operationKeys.join("|")) return false;
	if (
		value.schemaVersion !== 1 ||
		typeof value.kind !== "string" ||
		!WORKFLOW_DECISION_KINDS.has(value.kind as DurableDecisionKind)
	)
		return false;
	if (![value.targetDigest, value.effectDigest, value.preconditionDigest].every(isNonEmptyString)) return false;
	if (
		![value.readSet, value.writeSet].every(
			(set): set is readonly unknown[] =>
				Array.isArray(set) && set.every((entry) => typeof entry === "string" && entry.length > 0),
		)
	) {
		return false;
	}
	const effectFacts = value.effectFacts;
	if (!isRecord(effectFacts)) return false;
	const effectFactKeys = [
		"authorityMutation",
		"contractMutation",
		"destructiveOrIrreversible",
		"externalSideEffect",
		"localWrite",
		"resourceEnvelopeMutation",
	];
	return (
		Object.keys(effectFacts).sort().join("|") === effectFactKeys.join("|") &&
		effectFactKeys.every((key) => typeof effectFacts[key] === "boolean")
	);
}

function assertTypedOperation(value: unknown): asserts value is WorkflowTypedOperation {
	if (!isExactWorkflowTypedOperation(value)) throw new Error("Workflow operation preimage is unknown or malformed.");
}

function assertOperation(value: WorkflowOperation): void {
	if (
		!isRecord(value) ||
		typeof value.kind !== "string" ||
		!WORKFLOW_DECISION_KINDS.has(value.kind as DurableDecisionKind) ||
		!isNonEmptyString(value.preimageDigest)
	) {
		throw new Error("Workflow operation is unknown or malformed.");
	}
	assertArtifactRef(value.preimageRef, "Workflow operation preimage");
}

interface ResolvedWorkflowOperation {
	typed: WorkflowTypedOperation;
	concrete: WorkflowConcreteEffect;
	preimage: WorkflowEffectPreimage;
	normalizedReadSet: readonly string[];
	normalizedWriteSet: readonly string[];
	effectClasses: readonly DurableEffectClass[];
}

type WorkflowDecisionBoundary = Pick<
	WorkflowDecisionContext,
	"currentRevision" | "configDigest" | "profileDigest" | "revisionRegistryDigest"
>;

function decisionBoundaryDigest(boundary: WorkflowDecisionBoundary): string {
	return digestObject({
		currentRevision: boundary.currentRevision,
		configDigest: boundary.configDigest,
		profileDigest: boundary.profileDigest,
		revisionRegistryDigest: boundary.revisionRegistryDigest,
	});
}

function stageCharterDigest(input: {
	stage: DurableDecisionStage;
	lensRole: DurableLensRole | null;
	targetDigest: string;
	effectDigest: string;
	stateDigest: string;
	boundary: WorkflowDecisionBoundary;
	executionBindingDigest: string;
}): string {
	return digestObject({
		stage: input.stage,
		lensRole: input.lensRole,
		target: input.targetDigest,
		effect: input.effectDigest,
		state: input.stateDigest,
		boundaryDigest: decisionBoundaryDigest(input.boundary),
		executionBindingDigest: input.executionBindingDigest,
	});
}

function executionIdentityBindingDigest(input: {
	decision: DurableDecisionRecord;
	current: WorkflowDecisionBoundary & WorkflowEpochRef;
	stage: DurableDecisionStage;
	lensRole: DurableLensRole | null;
}): string {
	return digestObject({
		decisionId: input.decision.decisionId,
		decisionRevision: input.current.currentRevision,
		attemptToken: input.decision.attemptToken,
		nonce: input.decision.nonce,
		executionKey: input.decision.executionKey,
		stage: input.stage,
		lensRole: input.lensRole,
		epochRef: {
			storeEpoch: input.current.storeEpoch,
			coordinatorEpoch: input.current.coordinatorEpoch,
		},
		boundaryDigest: decisionBoundaryDigest(input.current),
	});
}

function assertConcreteEffectBinding(kind: DurableDecisionKind, concrete: WorkflowConcreteEffect): void {
	const binding = DECISION_EFFECT_BINDINGS[kind];
	if (binding === undefined) throw new Error(`Decision kind ${kind} has no closed concrete-effect mapping.`);
	if (concrete.kind !== binding.kind || concrete.kind !== "session_mutation" || concrete.target !== binding.target)
		throw new Error(`Decision kind ${kind} is not bound to the resolved concrete effect kind and target.`);
}

function deriveConcreteOperationFacts(
	kind: DurableDecisionKind,
	concrete: WorkflowConcreteEffect,
): Pick<ResolvedWorkflowOperation, "normalizedReadSet" | "normalizedWriteSet" | "effectClasses"> {
	assertConcreteEffectBinding(kind, concrete);
	if (concrete.kind !== "session_mutation")
		throw new Error(`Decision kind ${kind} is not bound to a session mutation effect.`);
	const normalizedReadSet: string[] = [];
	const normalizedWriteSet = normalizePathSet([concrete.target]);
	const effectClasses = new Set<DurableEffectClass>();
	if (concrete.target === "settings" || CONSEQUENTIAL_OPERATION_KINDS.has(kind)) {
		effectClasses.add("configuration");
	} else if (concrete.target === "goal" || kind === "goal_contract" || kind === "scorecard") {
		effectClasses.add("goal_contract_or_scorecard");
	} else if (kind === "resource_envelope") {
		effectClasses.add("authority_or_resource");
	} else {
		effectClasses.add("owned_reversible_local_write");
	}
	return {
		normalizedReadSet,
		normalizedWriteSet,
		effectClasses: [...effectClasses].sort(),
	};
}

async function resolveHostOperation(
	operation: WorkflowOperation,
	decisionHost: Pick<WorkflowDecisionHost, "resolveOperation" | "receiptContext">,
): Promise<ResolvedWorkflowOperation> {
	assertOperation(operation);
	const resolved = await decisionHost.resolveOperation(operation);
	if (!isRecord(resolved) || !isRecord(resolved.preimage)) throw new Error("Workflow operation preimage is missing.");
	assertTypedOperation(resolved.typed);
	const preimage = resolved.preimage;
	assertArtifactRef(preimage.artifactRef, "Workflow operation preimage");
	if (preimage.codec !== "canonical_json" || preimage.immutable !== true)
		throw new Error("Workflow operation preimage must be immutable canonical JSON.");
	if (!sameArtifactRef(preimage.artifactRef, operation.preimageRef))
		throw new Error("Workflow operation preimage is stale or forged.");
	const artifact = await decisionHost.receiptContext.artifactResolver.resolve(operation.preimageRef);
	if (
		!artifact.exists ||
		artifact.envelope.codec !== "canonical_json" ||
		artifact.envelope.immutable !== true ||
		!sameArtifactRef(artifact.envelope.ref, operation.preimageRef) ||
		artifact.verifiedDigest !== operation.preimageRef.digest ||
		artifact.verifiedSizeBytes !== operation.preimageRef.sizeBytes ||
		artifact.bytes.byteLength !== operation.preimageRef.sizeBytes ||
		sha256Hex(artifact.bytes) !== operation.preimageRef.digest
	) {
		throw new Error("Workflow operation preimage is not resolver-verified and content-addressed.");
	}
	let parsedConcrete: unknown;
	try {
		parsedConcrete = parseCanonicalJsonBytes(artifact.bytes);
	} catch {
		throw new Error("Workflow operation preimage is not a canonical closed concrete effect.");
	}
	if (!isConcreteEffectValue(parsedConcrete))
		throw new Error("Workflow operation preimage is not a canonical closed concrete effect.");
	const concreteBytes = canonicalJsonBytes(parsedConcrete);
	if (!bytesEqual(concreteBytes, artifact.bytes))
		throw new Error("Workflow operation preimage is not canonical closed concrete-effect bytes.");
	const concreteDigest = sha256Hex(concreteBytes);
	const typedBytes = canonicalJsonBytes(resolved.typed);
	const reparsedTyped: unknown = parseCanonicalJsonBytes(typedBytes);
	assertTypedOperation(reparsedTyped);
	const derivedFacts = deriveConcreteOperationFacts(reparsedTyped.kind, parsedConcrete);
	if (
		!bytesEqual(concreteBytes, preimage.bytes) ||
		preimage.verifiedDigest !== operation.preimageDigest ||
		preimage.verifiedDigest !== operation.preimageRef.digest ||
		preimage.verifiedSizeBytes !== operation.preimageRef.sizeBytes ||
		preimage.bytes.byteLength !== operation.preimageRef.sizeBytes ||
		sha256Hex(preimage.bytes) !== preimage.verifiedDigest ||
		preimage.verifiedDigest !== concreteDigest ||
		resolved.typed.effectDigest !== concreteDigest ||
		operation.kind !== reparsedTyped.kind ||
		digestObject(normalizePathSet(reparsedTyped.readSet)) !== digestObject(derivedFacts.normalizedReadSet) ||
		digestObject(normalizePathSet(reparsedTyped.writeSet)) !== digestObject(derivedFacts.normalizedWriteSet)
	) {
		throw new Error("Workflow operation preimage is stale or forged.");
	}
	return {
		typed: reparsedTyped,
		concrete: parsedConcrete,
		preimage: {
			...preimage,
			artifactRef: operation.preimageRef,
			bytes: artifact.bytes,
			verifiedDigest: artifact.verifiedDigest,
			verifiedSizeBytes: artifact.verifiedSizeBytes,
		},
		normalizedReadSet: derivedFacts.normalizedReadSet,
		normalizedWriteSet: derivedFacts.normalizedWriteSet,
		effectClasses: derivedFacts.effectClasses,
	};
}

function deriveMateriality(operation: ResolvedWorkflowOperation): DurableMateriality {
	if (
		CONSEQUENTIAL_OPERATION_KINDS.has(operation.typed.kind) ||
		operation.effectClasses.some((effectClass) =>
			[
				"configuration",
				"goal_contract_or_scorecard",
				"authority_or_resource",
				"external_side_effect",
				"destructive_or_irreversible",
				"git_or_publication",
			].includes(effectClass),
		)
	)
		return "consequential";
	if (operation.normalizedWriteSet.length > 0) return "material";
	return "routine";
}

function classifyResolvedHostOperation(
	operation: ResolvedWorkflowOperation,
	rulesetDigest: string,
	boundary?: WorkflowDecisionBoundary,
): DurableHostDecisionClassification {
	if (!isNonEmptyString(rulesetDigest)) throw new Error("Workflow decision ruleset digest is required.");
	const normalizedReadSet = operation.normalizedReadSet;
	const normalizedWriteSet = operation.normalizedWriteSet;
	const normalizedEffectClasses = operation.effectClasses;
	const derivedMateriality = deriveMateriality(operation);
	const targetBinding =
		boundary === undefined
			? { target: operation.typed.targetDigest, readSet: normalizedReadSet }
			: {
					target: operation.typed.targetDigest,
					readSet: normalizedReadSet,
					boundaryDigest: decisionBoundaryDigest(boundary),
				};
	const effectBinding =
		boundary === undefined
			? { effect: operation.typed.effectDigest, writeSet: normalizedWriteSet }
			: {
					effect: operation.typed.effectDigest,
					writeSet: normalizedWriteSet,
					boundaryDigest: decisionBoundaryDigest(boundary),
				};
	return {
		classifier: "host",
		rulesetDigest,
		effectClasses: normalizedEffectClasses,
		normalizedReadSet,
		normalizedWriteSet,
		derivedMateriality,
		requiresUserApproval: derivedMateriality !== "routine" || normalizedEffectClasses.includes("unknown"),
		reasonCodes: normalizedEffectClasses,
		classifiedTargetDigest: digestObject(targetBinding),
		classifiedEffectDigest: digestObject(effectBinding),
	};
}

function assertTrustedDecisionObservation(observation: WorkflowDecisionHostObservation): WorkflowDecisionContext {
	if (
		!isFiniteIsoDate(observation.trustedNow) ||
		observation.context.now !== observation.trustedNow ||
		!isNonEmptyString(observation.revisionsDigest)
	) {
		throw new Error("Decision host observation has no trusted finite clock.");
	}
	if (
		!isSafeEpoch(observation.context.storeEpoch) ||
		!isSafeEpoch(observation.context.coordinatorEpoch) ||
		!Number.isSafeInteger(observation.context.currentRevision) ||
		observation.context.currentRevision < 1 ||
		!isNonEmptyString(observation.context.stateDigest) ||
		!isNonEmptyString(observation.context.executionKey)
	) {
		throw new Error("Decision host observation has no current authenticated context.");
	}
	const digestFields: readonly (keyof WorkflowDecisionContext)[] = [
		"objectiveDigest",
		"contractDigest",
		"scorecardDigest",
		"planDigest",
		"workspaceDigest",
		"evidenceDigest",
		"parserDigest",
		"evaluatorDigest",
		"guardDigest",
		"regressionDigest",
		"redTeamDigest",
		"configDigest",
		"profileDigest",
		"revisionRegistryDigest",
	];
	if (digestFields.some((field) => !isNonEmptyString(observation.context[field])))
		throw new Error("Decision host observation has an incomplete digest closure.");
	if (observation.context.blockerDigest !== null && !isNonEmptyString(observation.context.blockerDigest))
		throw new Error("Decision host observation has an invalid blocker digest.");
	for (const capability of observation.requiredCapabilities) {
		if (!WORKFLOW_AUTHORITY_CAPABILITIES.has(capability))
			throw new Error("Decision host observation contains an unknown authority capability.");
	}
	return structuredClone(observation.context);
}

function assertDecisionScope(
	scope: unknown,
): asserts scope is { kind: "workflow"; workflowId: string; rootSessionId: string } {
	if (
		!isRecord(scope) ||
		scope.kind !== "workflow" ||
		!isNonEmptyString(scope.workflowId) ||
		!isNonEmptyString(scope.rootSessionId)
	) {
		throw new Error("Workflow decision scope is invalid.");
	}
}

function assertDecisionOperationMatches(decision: DurableDecisionRecord, operation: ResolvedWorkflowOperation): void {
	if (
		decision.kind !== operation.typed.kind ||
		decision.targetDigest !== operation.typed.targetDigest ||
		decision.effectDigest !== operation.typed.effectDigest ||
		decision.preconditionDigest !== operation.typed.preconditionDigest ||
		digestObject(operation.normalizedReadSet) !== digestObject(normalizePathSet(decision.readSet)) ||
		digestObject(operation.normalizedWriteSet) !== digestObject(normalizePathSet(decision.writeSet))
	) {
		throw new Error("Decision operation preimage is stale or forged.");
	}
}

function assertDecisionClassificationBoundary(
	decision: DurableDecisionRecord,
	current: WorkflowDecisionBoundary,
): void {
	const boundaryDigest = decisionBoundaryDigest(current);
	if (
		decision.hostClassification.classifiedTargetDigest !==
			digestObject({
				target: decision.targetDigest,
				readSet: normalizePathSet(decision.readSet),
				boundaryDigest,
			}) ||
		decision.hostClassification.classifiedEffectDigest !==
			digestObject({
				effect: decision.effectDigest,
				writeSet: normalizePathSet(decision.writeSet),
				boundaryDigest,
			})
	) {
		throw new Error("Decision host classification is stale or forged.");
	}
}

function assertPersistedHostClassification(decision: DurableDecisionRecord, current: WorkflowDecisionBoundary): void {
	const classification = decision.hostClassification;
	const classificationKeys = [
		"classifier",
		"classifiedEffectDigest",
		"classifiedTargetDigest",
		"derivedMateriality",
		"effectClasses",
		"normalizedReadSet",
		"normalizedWriteSet",
		"reasonCodes",
		"requiresUserApproval",
		"rulesetDigest",
	];
	if (Object.keys(classification).sort().join("|") !== classificationKeys.sort().join("|"))
		throw new Error("Decision host classification has an unknown or missing field.");
	if (
		classification.classifier !== "host" ||
		!isNonEmptyString(classification.rulesetDigest) ||
		classification.effectClasses.length === 0 ||
		classification.effectClasses.some((effectClass) => !WORKFLOW_EFFECT_CLASSES.has(effectClass))
	) {
		throw new Error("Decision host classification is unknown or malformed.");
	}
	const sortedEffectClasses = [...new Set(classification.effectClasses)].sort();
	if (
		sortedEffectClasses.length !== classification.effectClasses.length ||
		sortedEffectClasses.some((effectClass, index) => effectClass !== classification.effectClasses[index])
	) {
		throw new Error("Decision host classification effect classes are not canonical.");
	}
	if (
		classification.reasonCodes.length !== classification.effectClasses.length ||
		classification.reasonCodes.some((reasonCode, index) => reasonCode !== classification.effectClasses[index])
	) {
		throw new Error("Decision host classification reason codes are not bound to effect classes.");
	}
	let normalizedReadSet: string[];
	let normalizedWriteSet: string[];
	try {
		if (
			!Array.isArray(classification.normalizedReadSet) ||
			!classification.normalizedReadSet.every(isNonEmptyString) ||
			!Array.isArray(classification.normalizedWriteSet) ||
			!classification.normalizedWriteSet.every(isNonEmptyString)
		)
			throw new Error();
		normalizedReadSet = normalizePathSet(classification.normalizedReadSet);
		normalizedWriteSet = normalizePathSet(classification.normalizedWriteSet);
	} catch {
		throw new Error("Decision host classification paths are not canonical.");
	}
	if (
		digestObject(normalizedReadSet) !== digestObject(classification.normalizedReadSet) ||
		digestObject(normalizedWriteSet) !== digestObject(classification.normalizedWriteSet)
	) {
		throw new Error("Decision host classification paths are not canonical.");
	}
	if (
		!isNonEmptyString(classification.classifiedTargetDigest) ||
		!isNonEmptyString(classification.classifiedEffectDigest)
	)
		throw new Error("Decision host classification digests are incomplete.");
	const consequentialClasses = new Set<DurableEffectClass>([
		"configuration",
		"goal_contract_or_scorecard",
		"authority_or_resource",
		"external_side_effect",
		"destructive_or_irreversible",
		"git_or_publication",
	]);
	const expectedMateriality: DurableMateriality = classification.effectClasses.some((effectClass) =>
		consequentialClasses.has(effectClass),
	)
		? "consequential"
		: normalizedWriteSet.length > 0
			? "material"
			: "routine";
	if (
		classification.derivedMateriality !== expectedMateriality ||
		classification.requiresUserApproval !==
			(expectedMateriality !== "routine" || classification.effectClasses.includes("unknown"))
	) {
		throw new Error("Decision host classification materiality is stale or forged.");
	}
	assertDecisionClassificationBoundary(decision, current);
}

function assertAuthorityCapabilities(
	decision: DurableDecisionRecord,
	available: readonly WorkflowAuthorityCapability[],
): void {
	const availableSet = new Set(available);
	for (const capability of decision.authority) {
		if (!WORKFLOW_AUTHORITY_CAPABILITIES.has(capability) || !availableSet.has(capability))
			throw new Error("Decision authority is not currently available.");
	}
}

function requiredCapabilitiesForOperation(
	operation: ResolvedWorkflowOperation,
	classification: DurableHostDecisionClassification,
): ReadonlySet<WorkflowAuthorityCapability> {
	const required = new Set<WorkflowAuthorityCapability>(["observe_workflow"]);
	if (classification.normalizedReadSet.length > 0) required.add("read_workspace");
	if (classification.normalizedWriteSet.length > 0) required.add("write_owned_paths");
	if (
		classification.effectClasses.includes("configuration") ||
		classification.effectClasses.includes("goal_contract_or_scorecard") ||
		operation.typed.kind === "profile_selection"
	)
		required.add("propose_transition");
	if (
		classification.effectClasses.includes("authority_or_resource") ||
		classification.effectClasses.includes("external_side_effect") ||
		classification.effectClasses.includes("destructive_or_irreversible")
	)
		required.add("invoke_host_effect");
	if (operation.typed.kind === "resource_envelope") required.add("consume_resource_lease");
	if (operation.typed.kind === "goal_binding" || operation.typed.kind === "goal_transition")
		required.add("apply_goal_projection");
	if (operation.typed.kind === "progress_acceptance") required.add("accept_progress");
	if (operation.typed.kind === "completion") required.add("accept_completion");
	if (operation.typed.kind === "memory_write") required.add("write_canonical_knowledge");
	if (operation.concrete.kind === "child_process_spawn") required.add("spawn_child");
	if (classification.requiresUserApproval) required.add("request_user_approval");
	return required;
}

function assertRequiredOperationCapabilities(
	decision: DurableDecisionRecord,
	available: readonly WorkflowAuthorityCapability[],
	operation: ResolvedWorkflowOperation,
	classification: DurableHostDecisionClassification,
): void {
	const declared = new Set(decision.authority);
	const availableSet = new Set(available);
	for (const capability of requiredCapabilitiesForOperation(operation, classification)) {
		if (!declared.has(capability)) throw new Error("Decision omits authority required by the concrete operation.");
		if (!availableSet.has(capability))
			throw new Error("Current host lacks authority required by the concrete operation.");
	}
}

function assertDecisionContextBinding(decision: DurableDecisionRecord, current: WorkflowDecisionContext): void {
	if (
		!isNonEmptyString(decision.attemptToken) ||
		!isNonEmptyString(decision.nonce) ||
		decision.revision !== current.currentRevision ||
		decision.executionKey !== current.executionKey ||
		decision.storeEpoch !== current.storeEpoch ||
		decision.coordinatorEpoch !== current.coordinatorEpoch ||
		decision.stateDigest !== current.stateDigest ||
		decision.objectiveDigest !== current.objectiveDigest ||
		decision.contractDigest !== current.contractDigest ||
		decision.scorecardDigest !== current.scorecardDigest ||
		decision.planDigest !== current.planDigest ||
		decision.workspaceDigest !== current.workspaceDigest ||
		decision.evidenceDigest !== current.evidenceDigest ||
		decision.parserDigest !== current.parserDigest ||
		decision.evaluatorDigest !== current.evaluatorDigest ||
		decision.guardDigest !== current.guardDigest ||
		decision.regressionDigest !== current.regressionDigest ||
		decision.redTeamDigest !== current.redTeamDigest ||
		decision.blockerDigest !== current.blockerDigest
	) {
		throw new Error("Decision authorization digest or blocker state is stale.");
	}
}

function decisionAuthorityBindingDigest(decision: DurableDecisionRecord): string {
	return digestObject({
		decisionScope: decision.decisionScope,
		decisionId: decision.decisionId,
		revision: decision.revision,
		parentDecisionIds: decision.parentDecisionIds,
		kind: decision.kind,
		hostClassification: decision.hostClassification,
		storeEpoch: decision.storeEpoch,
		coordinatorEpoch: decision.coordinatorEpoch,
		targetDigest: decision.targetDigest,
		effectDigest: decision.effectDigest,
		preconditionDigest: decision.preconditionDigest,
		authority: decision.authority,
		expiresAt: decision.expiresAt,
		objectiveDigest: decision.objectiveDigest,
		contractDigest: decision.contractDigest,
		scorecardDigest: decision.scorecardDigest,
		planDigest: decision.planDigest,
		stateDigest: decision.stateDigest,
		workspaceDigest: decision.workspaceDigest,
		evidenceDigest: decision.evidenceDigest,
		parserDigest: decision.parserDigest,
		evaluatorDigest: decision.evaluatorDigest,
		guardDigest: decision.guardDigest,
		regressionDigest: decision.regressionDigest,
		blockerDigest: decision.blockerDigest,
		redTeamDigest: decision.redTeamDigest,
		readSet: decision.readSet,
		writeSet: decision.writeSet,
		attemptToken: decision.attemptToken,
		nonce: decision.nonce,
		executionKey: decision.executionKey,
		proposerSessionId: decision.proposerSessionId,
		lensSessionIds: decision.lensSessionIds,
		verifierSessionId: decision.verifierSessionId,
		synthesizerSessionId: decision.synthesizerSessionId,
		redTeamSessionId: decision.redTeamSessionId,
	});
}

function assertCurrentPersistedDecisionBinding(
	decision: DurableDecisionRecord,
	currentDecision: WorkflowDecisionRecord,
	current: WorkflowDecisionContext,
): void {
	if (!isRecord(currentDecision)) throw new Error("Current persisted decision authority is missing.");
	assertDecisionScope(currentDecision.decisionScope);
	assertDecisionContextBinding(currentDecision, current);
	if (decisionAuthorityBindingDigest(decision) !== decisionAuthorityBindingDigest(currentDecision)) {
		throw new Error("Decision is not bound to the current persisted decision authority.");
	}
}

function assertDecisionExpiry(decision: DurableDecisionRecord, trustedNow: string): void {
	if (!Number.isSafeInteger(decision.revision) || decision.revision < 1 || !isFiniteIsoDate(decision.expiresAt))
		throw new Error("Decision revision or expiry is invalid.");
	const now = Date.parse(trustedNow);
	const expiresAt = Date.parse(decision.expiresAt);
	if (expiresAt <= now || expiresAt - now > MAX_DECISION_TTL_MILLISECONDS)
		throw new Error("Decision revision is expired or exceeds the bounded TTL.");
}

function assertRequiredStagePlan(decision: DurableDecisionRecord): void {
	const stagePlan = decision.stagePlan;
	if (
		stagePlan.stages.length !== REQUIRED_STAGES.length ||
		stagePlan.stages.some((stage, index) => stage !== REQUIRED_STAGES[index]) ||
		stagePlan.lensRoles.length !== REQUIRED_LENS_ROLES.length ||
		stagePlan.lensRoles.some((role, index) => role !== REQUIRED_LENS_ROLES[index]) ||
		stagePlan.charterDigests.length !== REQUIRED_STAGES.length ||
		stagePlan.charterDigests.some((digest) => !isNonEmptyString(digest)) ||
		stagePlan.planDigest !== digestObject(stagePlan.charterDigests)
	) {
		throw new Error("Decision does not contain the closed six-stage plan.");
	}
}

async function assertResolverVerifiedArtifact(
	context: WorkflowHostReceiptConsumerContext,
	ref: WorkflowArtifactRef,
): Promise<void> {
	assertArtifactRef(ref, "Decision stage artifact");
	const artifact = await context.artifactResolver.resolve(ref);
	if (
		!artifact.exists ||
		artifact.envelope.immutable !== true ||
		!sameArtifactRef(artifact.envelope.ref, ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	) {
		throw new Error("Decision stage output is not resolver-verified immutable bytes.");
	}
}

async function assertStageVerdict(
	verdict: DurableStageVerdict,
	expected: {
		decisionId: string;
		revision: number;
		stage: DurableDecisionStage;
		lensRole: DurableLensRole | null;
		stateDigest: string;
		charterDigest: string;
		epochRef: WorkflowEpochRef;
		sessionIds: ReadonlySet<string>;
		executionIds: ReadonlySet<string>;
		stageIds: ReadonlySet<string>;
		outputPaths: readonly string[];
		context: WorkflowHostReceiptConsumerContext;
	},
): Promise<void> {
	if (
		verdict.decisionId !== expected.decisionId ||
		verdict.decisionRevision !== expected.revision ||
		verdict.stage !== expected.stage ||
		verdict.lensRole !== expected.lensRole ||
		verdict.disposition !== "accepted" ||
		!isNonEmptyString(verdict.stageId) ||
		!isNonEmptyString(verdict.sessionId) ||
		!isNonEmptyString(verdict.executionIdentity) ||
		verdict.storeEpoch !== expected.epochRef.storeEpoch ||
		verdict.coordinatorEpoch !== expected.epochRef.coordinatorEpoch ||
		verdict.inputStateDigest !== expected.stateDigest ||
		!isNonEmptyString(verdict.evidenceDigest) ||
		verdict.independence.freshContext !== true ||
		verdict.independence.distinctSessionIdentity !== true ||
		verdict.independence.distinctExecutionIdentity !== true ||
		verdict.independence.sharedConversation !== false ||
		verdict.independence.sharedMutableOutput !== false ||
		verdict.independence.inputStateDigest !== expected.stateDigest ||
		verdict.independence.charterDigest !== expected.charterDigest ||
		expected.sessionIds.has(verdict.sessionId) ||
		expected.executionIds.has(verdict.executionIdentity) ||
		expected.stageIds.has(verdict.stageId) ||
		verdict.artifactRefs.length === 0
	) {
		throw new Error("Decision stage verdict provenance is stale, forged, or not independent.");
	}
	const localPaths: string[] = [];
	for (const ref of verdict.artifactRefs) {
		await assertResolverVerifiedArtifact(expected.context, ref);
		assertNoOverlappingWrites(localPaths, [ref.relativePath]);
		assertNoOverlappingWrites(expected.outputPaths, [ref.relativePath]);
		localPaths.push(ref.relativePath);
	}
}

async function runFreshSixStageGate(
	decision: WorkflowDecisionRecord,
	operation: WorkflowOperation,
	inputStateDigest: string,
	runner: FreshStageRunner,
	decisionHost: WorkflowDecisionHost,
	reservationStore: WorkflowWriteSetReservationStore,
	freshGateFence: WorkflowFreshGateFence,
	rulesetDigest: string,
): Promise<WorkflowDecisionRecord> {
	assertDecisionScope(decision.decisionScope);
	const observed = await decisionHost.observe({
		workflowId: decision.decisionScope.workflowId,
		decisionId: decision.decisionId,
		operation,
	});
	const current = assertTrustedDecisionObservation(observed);
	if (inputStateDigest !== current.stateDigest) throw new Error("Decision input state is stale.");
	assertDecisionContextBinding(decision, current);
	assertCurrentPersistedDecisionBinding(decision, observed.currentDecision, current);
	if (observed.currentDecision.disposition !== "proposed")
		throw new Error("Current persisted decision is not fresh-gateable.");
	const resolved = await resolveHostOperation(operation, decisionHost);
	assertDecisionOperationMatches(decision, resolved);
	const classification = classifyResolvedHostOperation(resolved, rulesetDigest, current);
	if (digestObject(classification) !== digestObject(decision.hostClassification))
		throw new Error("Decision host classification is stale or forged.");
	assertDecisionExpiry(decision, current.now);
	assertAuthorityCapabilities(decision, observed.requiredCapabilities);
	assertRequiredOperationCapabilities(decision, observed.requiredCapabilities, resolved, classification);
	if (
		!observed.requiredCapabilities.includes("observe_workflow") ||
		(classification.requiresUserApproval && !observed.requiredCapabilities.includes("request_user_approval"))
	) {
		throw new Error("Decision host capabilities do not authorize this gate.");
	}
	for (const existingWriteSet of current.overlappingWriteSets)
		assertNoOverlappingWrites(classification.normalizedWriteSet, existingWriteSet);
	if (decision.disposition !== "proposed") throw new Error("Decision disposition is not fresh-gateable.");
	const fenceResult = await freshGateFence.claim({
		workflowId: decision.decisionScope.workflowId,
		decisionId: decision.decisionId,
		revision: current.currentRevision,
		expectedDisposition: "proposed",
		attemptToken: decision.attemptToken,
		nonce: decision.nonce,
		executionKey: decision.executionKey,
		operationDigest: resolved.preimage.verifiedDigest,
		epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
		boundaryDigest: decisionBoundaryDigest(current),
	});
	if (fenceResult !== "claimed") throw new Error("Decision fresh-gate fence is already claimed.");
	const reservation = await reservationStore.reserve({
		workflowId: decision.decisionScope.workflowId,
		decisionId: decision.decisionId,
		revision: current.currentRevision,
		normalizedPaths: classification.normalizedWriteSet,
		expectedHeadDigest: current.stateDigest,
		epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
	});
	try {
		await reservationStore.assertHeld({
			reservation,
			decisionId: decision.decisionId,
			revision: current.currentRevision,
			epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
		});
		const verdicts: DurableStageVerdict[] = [];
		const sessionIds = new Set<string>();
		const executionIds = new Set<string>();
		const stageIds = new Set<string>();
		const outputPaths: string[] = [];
		for (const stage of REQUIRED_STAGES) {
			const lensRole = REQUIRED_LENS_ROLES[verdicts.length] ?? null;
			const executionBindingDigest = executionIdentityBindingDigest({
				decision,
				current: {
					...current,
					storeEpoch: current.storeEpoch,
					coordinatorEpoch: current.coordinatorEpoch,
				},
				stage,
				lensRole,
			});
			const charterDigest = stageCharterDigest({
				stage,
				lensRole,
				targetDigest: resolved.typed.targetDigest,
				effectDigest: resolved.typed.effectDigest,
				stateDigest: inputStateDigest,
				boundary: current,
				executionBindingDigest,
			});
			const issued = await decisionHost.issueStageExecutionIdentity({
				decisionId: decision.decisionId,
				revision: current.currentRevision,
				attemptToken: decision.attemptToken,
				nonce: decision.nonce,
				executionKey: decision.executionKey,
				bindingDigest: executionBindingDigest,
				stage,
				lensRole,
				epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
			});
			if (
				!isNonEmptyString(issued.executionIdentity) ||
				!isNonEmptyString(issued.sessionId) ||
				sessionIds.has(issued.sessionId) ||
				executionIds.has(issued.executionIdentity) ||
				issued.bindingDigest !== executionBindingDigest
			) {
				throw new Error("Decision host issued duplicate or empty stage identity.");
			}
			const observation = await runner.run({
				decision: structuredClone({ ...decision, hostClassification: classification, stageVerdicts: verdicts }),
				stage,
				lensRole,
				inputStateDigest,
				charterDigest,
				priorVerdicts: structuredClone(verdicts),
				hostExecutionIdentity: issued.executionIdentity,
				hostSessionId: issued.sessionId,
			});
			if (
				!isNonEmptyString(observation.executionIdentity) ||
				!isNonEmptyString(observation.sessionId) ||
				observation.executionIdentity !== issued.executionIdentity ||
				observation.sessionId !== issued.sessionId ||
				!isNonEmptyString(observation.outputDigest) ||
				!isNonEmptyString(observation.evidenceDigest)
			) {
				throw new Error("Stage output is not bound to the host-issued execution identity.");
			}
			const verdict = await decisionHost.resolveStageOutput({
				decisionId: decision.decisionId,
				revision: current.currentRevision,
				attemptToken: decision.attemptToken,
				nonce: decision.nonce,
				executionKey: decision.executionKey,
				bindingDigest: executionBindingDigest,
				operationDigest: resolved.preimage.verifiedDigest,
				stateDigest: inputStateDigest,
				epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
				stage,
				lensRole,
				executionIdentity: issued.executionIdentity,
				sessionId: issued.sessionId,
				charterDigest,
				observation,
			});
			await assertStageVerdict(verdict, {
				decisionId: decision.decisionId,
				revision: current.currentRevision,
				stage,
				lensRole,
				stateDigest: inputStateDigest,
				charterDigest,
				epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
				sessionIds,
				executionIds,
				stageIds,
				outputPaths,
				context: decisionHost.receiptContext,
			});
			if (
				verdict.artifactRefs.length !== observation.outputArtifactRefs.length ||
				verdict.artifactRefs.some((ref, index) => {
					const observedRef = observation.outputArtifactRefs[index];
					return observedRef === undefined || !sameArtifactRef(ref, observedRef);
				})
			) {
				throw new Error("Decision stage output artifact references are not bound to the stage observation.");
			}
			if (verdict.executionIdentity !== issued.executionIdentity || verdict.sessionId !== issued.sessionId)
				throw new Error("Decision stage identity is not host-bound.");
			sessionIds.add(verdict.sessionId);
			executionIds.add(verdict.executionIdentity);
			stageIds.add(verdict.stageId);
			outputPaths.push(...verdict.artifactRefs.map((ref) => ref.relativePath));
			verdicts.push(verdict);
			await reservationStore.assertHeld({
				reservation,
				decisionId: decision.decisionId,
				revision: current.currentRevision,
				epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
			});
		}
		const redTeamVerdict = verdicts[verdicts.length - 1];
		if (
			redTeamVerdict === undefined ||
			redTeamVerdict.stage !== "red_team" ||
			redTeamVerdict.artifactRefs.length === 0
		)
			throw new Error("Red-team must produce an immutable artifact before host adjudication.");
		const stagePlan = {
			stages: ["recon", "lens", "lens", "verification", "synthesis", "red_team"] as const,
			lensRoles: [null, "primary", "secondary", null, null, null] as const,
			charterDigests: verdicts.map((verdict) => verdict.independence.charterDigest) as [
				string,
				string,
				string,
				string,
				string,
				string,
			],
			planDigest: digestObject(verdicts.map((verdict) => verdict.independence.charterDigest)),
		};
		const adjudicationExecutionBindingDigest = executionIdentityBindingDigest({
			decision,
			current: {
				...current,
				storeEpoch: current.storeEpoch,
				coordinatorEpoch: current.coordinatorEpoch,
			},
			stage: "host_adjudication",
			lensRole: null,
		});
		const adjudicationIdentity = await decisionHost.issueStageExecutionIdentity({
			decisionId: decision.decisionId,
			revision: current.currentRevision,
			attemptToken: decision.attemptToken,
			nonce: decision.nonce,
			executionKey: decision.executionKey,
			bindingDigest: adjudicationExecutionBindingDigest,
			stage: "host_adjudication",
			lensRole: null,
			epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
		});
		if (
			!isNonEmptyString(adjudicationIdentity.executionIdentity) ||
			!isNonEmptyString(adjudicationIdentity.sessionId) ||
			sessionIds.has(adjudicationIdentity.sessionId) ||
			executionIds.has(adjudicationIdentity.executionIdentity) ||
			adjudicationIdentity.bindingDigest !== adjudicationExecutionBindingDigest
		) {
			throw new Error("Decision adjudication identity is not distinct.");
		}
		const adjudicationArtifactRef = redTeamVerdict.artifactRefs[0];
		const adjudicationDigest = digestObject({
			redTeamEvidenceDigest: redTeamVerdict.evidenceDigest,
			operationDigest: resolved.preimage.verifiedDigest,
			stateDigest: inputStateDigest,
			stagePlanDigest: stagePlan.planDigest,
			boundaryDigest: decisionBoundaryDigest(current),
			attemptToken: decision.attemptToken,
			nonce: decision.nonce,
			executionKey: decision.executionKey,
			executionBindingDigest: adjudicationExecutionBindingDigest,
		});
		const adjudicationBindingDigest = digestObject({
			decisionId: decision.decisionId,
			revision: current.currentRevision,
			operationDigest: resolved.preimage.verifiedDigest,
			stateDigest: inputStateDigest,
			boundaryDigest: decisionBoundaryDigest(current),
			attemptToken: decision.attemptToken,
			nonce: decision.nonce,
			executionKey: decision.executionKey,
			executionBindingDigest: adjudicationExecutionBindingDigest,
			epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
			executionIdentity: adjudicationIdentity.executionIdentity,
			sessionId: adjudicationIdentity.sessionId,
			verdictArtifactRef: adjudicationArtifactRef,
			verdictDigest: adjudicationDigest,
		});
		const adjudicationReceipt = await decisionHost.issueAdjudicationReceipt({
			workflowId: decision.decisionScope.workflowId,
			decisionId: decision.decisionId,
			decisionRevision: current.currentRevision,
			attemptToken: decision.attemptToken,
			nonce: decision.nonce,
			executionKey: decision.executionKey,
			operationDigest: resolved.preimage.verifiedDigest,
			stateDigest: inputStateDigest,
			epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
			executionIdentity: adjudicationIdentity.executionIdentity,
			sessionId: adjudicationIdentity.sessionId,
			verdictArtifactRef: adjudicationArtifactRef,
			verdictDigest: adjudicationDigest,
			bindingDigest: adjudicationBindingDigest,
			validUntil: decision.expiresAt,
		});
		if (!sameArtifactRef(adjudicationReceipt.artifactRef, adjudicationArtifactRef))
			throw new Error("Host adjudication receipt is not bound to the red-team artifact.");
		await resolveAndVerifyWorkflowHostReceipt({
			context: decisionHost.receiptContext,
			workflowId: decision.decisionScope.workflowId,
			expectedBindingDigest: adjudicationBindingDigest,
			receipt: adjudicationReceipt,
			currentStateDigest: current.stateDigest,
			currentRevision: current.currentRevision,
			trustedNow: current.now,
		});
		const hostAdjudication: DurableHostAdjudication = {
			stage: "host_adjudication",
			decisionId: decision.decisionId,
			decisionRevision: current.currentRevision,
			executionIdentity: adjudicationIdentity.executionIdentity,
			sessionId: adjudicationIdentity.sessionId,
			inputStateDigest,
			operationDigest: resolved.preimage.verifiedDigest,
			verdictArtifactRef: adjudicationArtifactRef,
			verdictDigest: adjudicationDigest,
			hostReceipt: adjudicationReceipt,
			disposition: "accepted",
		};
		return {
			...decision,
			hostClassification: classification,
			stagePlan,
			stageVerdicts: verdicts,
			hostAdjudication,
			writeSetReservation: {
				reservationId: reservation.reservationId,
				reservationDigest: reservation.reservationDigest,
			},
			disposition: classification.requiresUserApproval ? "awaiting_user" : "authorized",
		};
	} catch (error) {
		await reservationStore.release({
			reservation,
			epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
		});
		throw error;
	}
}

async function validateCurrentDecision(
	decision: WorkflowDecisionRecord,
	current: WorkflowDecisionContext,
	currentDecision: WorkflowDecisionRecord,
	operation: ResolvedWorkflowOperation | null,
	operationDigest: string | null,
	receiptContext: WorkflowHostReceiptConsumerContext,
	rulesetDigest: string,
): Promise<void> {
	assertDecisionScope(decision.decisionScope);
	assertDecisionContextBinding(decision, current);
	assertCurrentPersistedDecisionBinding(decision, currentDecision, current);
	assertDecisionExpiry(decision, current.now);
	assertRequiredStagePlan(decision);
	if (
		decision.hostClassification.classifier !== "host" ||
		decision.hostClassification.rulesetDigest !== rulesetDigest ||
		!isNonEmptyString(rulesetDigest)
	)
		throw new Error("Decision classification is not host-authenticated.");
	assertPersistedHostClassification(decision, current);
	if (operation !== null) {
		assertDecisionOperationMatches(decision, operation);
		const classification = classifyResolvedHostOperation(operation, rulesetDigest, current);
		if (digestObject(classification) !== digestObject(decision.hostClassification))
			throw new Error("Decision host classification is stale or forged.");
		if (operationDigest === null || decision.hostAdjudication.operationDigest !== operationDigest)
			throw new Error("Host adjudication is bound to a different operation revision.");
	}
	if (
		decision.executionKey !== current.executionKey ||
		decision.storeEpoch !== current.storeEpoch ||
		decision.coordinatorEpoch !== current.coordinatorEpoch ||
		decision.stateDigest !== current.stateDigest ||
		decision.objectiveDigest !== current.objectiveDigest ||
		decision.contractDigest !== current.contractDigest ||
		decision.scorecardDigest !== current.scorecardDigest ||
		decision.planDigest !== current.planDigest ||
		decision.workspaceDigest !== current.workspaceDigest ||
		decision.evidenceDigest !== current.evidenceDigest ||
		decision.parserDigest !== current.parserDigest ||
		decision.evaluatorDigest !== current.evaluatorDigest ||
		decision.guardDigest !== current.guardDigest ||
		decision.regressionDigest !== current.regressionDigest ||
		decision.redTeamDigest !== current.redTeamDigest ||
		current.blockerDigest !== decision.blockerDigest ||
		decision.blockerDigest !== null
	) {
		throw new Error("Decision authorization digest or blocker state is stale.");
	}
	const stageSessions = new Set<string>();
	const stageExecutions = new Set<string>();
	const stageIds = new Set<string>();
	const outputPaths: string[] = [];
	for (let index = 0; index < decision.stageVerdicts.length; index += 1) {
		const verdict = decision.stageVerdicts[index];
		const stage = REQUIRED_STAGES[index];
		const lensRole = REQUIRED_LENS_ROLES[index] ?? null;
		if (stage === undefined) throw new Error("Decision contains too many stage verdicts.");
		const executionBindingDigest = executionIdentityBindingDigest({
			decision,
			current: {
				...current,
				storeEpoch: current.storeEpoch,
				coordinatorEpoch: current.coordinatorEpoch,
			},
			stage,
			lensRole,
		});
		const expectedCharterDigest = stageCharterDigest({
			stage,
			lensRole,
			targetDigest: decision.targetDigest,
			effectDigest: decision.effectDigest,
			stateDigest: decision.stateDigest,
			boundary: current,
			executionBindingDigest,
		});
		if (decision.stagePlan.charterDigests[index] !== expectedCharterDigest)
			throw new Error("Decision stage charter is stale or forged.");
		await assertStageVerdict(verdict, {
			decisionId: decision.decisionId,
			revision: current.currentRevision,
			stage,
			lensRole,
			stateDigest: decision.stateDigest,
			charterDigest: expectedCharterDigest,
			epochRef: { storeEpoch: decision.storeEpoch, coordinatorEpoch: decision.coordinatorEpoch },
			sessionIds: stageSessions,
			executionIds: stageExecutions,
			stageIds,
			outputPaths,
			context: receiptContext,
		});
		stageSessions.add(verdict.sessionId);
		stageExecutions.add(verdict.executionIdentity);
		stageIds.add(verdict.stageId);
		outputPaths.push(...verdict.artifactRefs.map((ref) => ref.relativePath));
	}
	if (decision.stageVerdicts.length !== REQUIRED_STAGES.length)
		throw new Error("Decision does not contain one verdict for every required stage.");
	const hostAdjudication = decision.hostAdjudication;
	if (
		hostAdjudication.stage !== "host_adjudication" ||
		hostAdjudication.decisionId !== decision.decisionId ||
		hostAdjudication.decisionRevision !== current.currentRevision ||
		!isNonEmptyString(hostAdjudication.executionIdentity) ||
		!isNonEmptyString(hostAdjudication.sessionId) ||
		stageSessions.has(hostAdjudication.sessionId) ||
		stageExecutions.has(hostAdjudication.executionIdentity) ||
		hostAdjudication.inputStateDigest !== decision.stateDigest ||
		!isNonEmptyString(hostAdjudication.operationDigest) ||
		!isNonEmptyString(hostAdjudication.verdictDigest) ||
		hostAdjudication.disposition !== "accepted" ||
		!sameArtifactRef(hostAdjudication.hostReceipt.artifactRef, hostAdjudication.verdictArtifactRef) ||
		hostAdjudication.hostReceipt.payloadDigest !== hostAdjudication.verdictDigest ||
		hostAdjudication.hostReceipt.artifactRef.digest !== hostAdjudication.verdictArtifactRef.digest
	) {
		throw new Error("Decision does not contain an authenticated host adjudication.");
	}
	const adjudicationBindingDigest = digestObject({
		decisionId: decision.decisionId,
		revision: current.currentRevision,
		operationDigest: hostAdjudication.operationDigest,
		stateDigest: hostAdjudication.inputStateDigest,
		boundaryDigest: decisionBoundaryDigest(current),
		attemptToken: decision.attemptToken,
		nonce: decision.nonce,
		executionKey: decision.executionKey,
		executionBindingDigest: executionIdentityBindingDigest({
			decision,
			current: {
				...current,
				storeEpoch: current.storeEpoch,
				coordinatorEpoch: current.coordinatorEpoch,
			},
			stage: "host_adjudication",
			lensRole: null,
		}),
		epochRef: { storeEpoch: decision.storeEpoch, coordinatorEpoch: decision.coordinatorEpoch },
		executionIdentity: hostAdjudication.executionIdentity,
		sessionId: hostAdjudication.sessionId,
		verdictArtifactRef: hostAdjudication.verdictArtifactRef,
		verdictDigest: hostAdjudication.verdictDigest,
	});
	if (hostAdjudication.hostReceipt.bindingDigest !== adjudicationBindingDigest)
		throw new Error("Host adjudication receipt is not bound to the current decision tuple.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: receiptContext,
		workflowId: decision.decisionScope.workflowId,
		expectedBindingDigest: adjudicationBindingDigest,
		receipt: hostAdjudication.hostReceipt,
		currentStateDigest: current.stateDigest,
		currentRevision: current.currentRevision,
		trustedNow: current.now,
	});
}

function createGate(options: {
	rulesetDigest: string;
	decisionHost: WorkflowDecisionHost;
	reservationStore: WorkflowWriteSetReservationStore;
	freshGateFence: WorkflowFreshGateFence;
}): WorkflowDecisionGate {
	return {
		classify: async (operation) =>
			classifyResolvedHostOperation(
				await resolveHostOperation(operation, options.decisionHost),
				options.rulesetDigest,
			),
		validateVerdicts: async (decision) => {
			assertDecisionScope(decision.decisionScope);
			const observed = await options.decisionHost.current({
				workflowId: decision.decisionScope.workflowId,
				decisionId: decision.decisionId,
			});
			const current = assertTrustedDecisionObservation(observed);
			assertAuthorityCapabilities(decision, observed.requiredCapabilities);
			await validateCurrentDecision(
				decision,
				current,
				observed.currentDecision,
				null,
				null,
				options.decisionHost.receiptContext,
				options.rulesetDigest,
			);
		},
		authorize: async (decision, input) => {
			let current: WorkflowDecisionContext | null = null;
			try {
				assertDecisionScope(decision.decisionScope);
				const observed = await options.decisionHost.current({
					workflowId: decision.decisionScope.workflowId,
					decisionId: decision.decisionId,
				});
				current = assertTrustedDecisionObservation(observed);
				assertAuthorityCapabilities(decision, observed.requiredCapabilities);
				const operation = input.kind === "immutable_gate_token" ? input.operation : input;
				const resolved = await resolveHostOperation(operation, options.decisionHost);
				const resolvedOperationDigest = resolved.preimage.verifiedDigest;
				if (input.kind === "immutable_gate_token") {
					if (
						input.storeEpoch !== current.storeEpoch ||
						input.coordinatorEpoch !== current.coordinatorEpoch ||
						input.stagePlanDigest !== decision.stagePlan.planDigest ||
						input.resolvedOperationDigest !== resolvedOperationDigest ||
						!isFiniteIsoDate(input.expiresAt) ||
						Date.parse(input.expiresAt) <= Date.parse(current.now) ||
						input.tokenDigest !==
							digestObject({
								operation: input.operation,
								resolvedOperationDigest,
								stagePlanDigest: input.stagePlanDigest,
								storeEpoch: input.storeEpoch,
								coordinatorEpoch: input.coordinatorEpoch,
							})
					) {
						throw new Error("Immutable decision gate token is stale or forged.");
					}
				}
				await validateCurrentDecision(
					decision,
					current,
					observed.currentDecision,
					resolved,
					resolved.preimage.verifiedDigest,
					options.decisionHost.receiptContext,
					options.rulesetDigest,
				);
				const classification = classifyResolvedHostOperation(resolved, options.rulesetDigest, current);
				assertRequiredOperationCapabilities(decision, observed.requiredCapabilities, resolved, classification);
				for (const writeSet of current.overlappingWriteSets)
					assertNoOverlappingWrites(classification.normalizedWriteSet, writeSet);
				if (classification.requiresUserApproval && !observed.requiredCapabilities.includes("request_user_approval"))
					throw new Error("Current host capabilities do not authorize approval.");
				if (decision.writeSetReservation === undefined)
					throw new Error("Decision has no path-prefix reservation held to apply.");
				const reservation: WorkflowWriteSetReservation = {
					reservationId: decision.writeSetReservation.reservationId,
					decisionId: decision.decisionId,
					revision: current.currentRevision,
					normalizedPaths: classification.normalizedWriteSet,
					reservationDigest: decision.writeSetReservation.reservationDigest,
					expectedHeadDigest: current.stateDigest,
					status: "held",
				};
				await options.reservationStore.assertHeld({
					reservation,
					decisionId: decision.decisionId,
					revision: current.currentRevision,
					epochRef: { storeEpoch: current.storeEpoch, coordinatorEpoch: current.coordinatorEpoch },
				});
				if (!decision.hostAdjudication.hostReceipt.oneUse)
					throw new Error("Host adjudication receipt is not a one-use authorization witness.");
				await options.decisionHost.receiptContext.receiptResolver.consumeIfOneUse({
					receipt: decision.hostAdjudication.hostReceipt,
					workflowId: decision.decisionScope.workflowId,
					expectedBindingDigest: decision.hostAdjudication.hostReceipt.bindingDigest,
					currentRevision: current.currentRevision,
				});
				return classification.requiresUserApproval ? "awaiting_user" : "authorized";
			} catch (error) {
				if (decision.writeSetReservation !== undefined && decision.decisionScope.kind === "workflow") {
					await options.reservationStore
						.release({
							reservation: {
								reservationId: decision.writeSetReservation.reservationId,
								decisionId: decision.decisionId,
								revision: decision.revision,
								normalizedPaths: normalizePathSet(decision.writeSet),
								reservationDigest: decision.writeSetReservation.reservationDigest,
								expectedHeadDigest: current?.stateDigest ?? "",
								status: "released",
							},
							epochRef: { storeEpoch: decision.storeEpoch, coordinatorEpoch: decision.coordinatorEpoch },
						})
						.catch(() => undefined);
				}
				if (error instanceof WorkflowDecisionConflictError) return "conflicted";
				return "rejected";
			}
		},
		runFreshSixStageGate: (decision, operation, inputStateDigest, runner) =>
			runFreshSixStageGate(
				decision,
				operation,
				inputStateDigest,
				runner,
				options.decisionHost,
				options.reservationStore,
				options.freshGateFence,
				options.rulesetDigest,
			),
	};
}

/** Create the host-authoritative workflow decision gate.
 *
 * Args:
 * options: Host, ruleset, and reservation dependencies.
 * Return: A decision gate that classifies, validates, authorizes, and fresh-gates proposals.
 */
export function createHostDecisionGate(options: {
	rulesetDigest: string;
	decisionHost: WorkflowDecisionHost;
	reservationStore: WorkflowWriteSetReservationStore;
	freshGateFence: WorkflowFreshGateFence;
}): WorkflowDecisionGate {
	return createGate(options);
}
