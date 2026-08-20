import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/index.js";
import type { CustomMessage } from "../messages.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowAuthorityCapability,
} from "./contracts.js";
import { WORKFLOW_COMPUTE_CLASSES, type WorkflowComputeClass } from "./default-task-runtime.js";
import { WORKFLOW_REQUIRED_TASK_ROLES, WORKFLOW_TASK_ROLES, type WorkflowTaskRole } from "./recipes.js";
import type {
	WorkflowGoalAuthoritySourceRequest,
	WorkflowGoalBudgets,
	WorkflowGoalMetric,
	WorkflowStartRequest,
} from "./shell.js";

export const WORKFLOW_BRAINSTORM_CUSTOM_TYPE = "prime-agent.workflow-brainstorm";
export const WORKFLOW_PROPOSE_TOOL_NAME = "workflow_propose";
const SESSION_WORKFLOW_GOAL_SOURCE_URI = /^session-artifact:\/\/workflow-goal-sources\/sha256=([a-f0-9]{64})\.json$/u;

const workflowMetricSchema = Type.Object(
	{
		metricId: Type.String({ minLength: 1 }),
		requirementId: Type.String({ minLength: 1 }),
		direction: Type.Union([Type.Literal("at_least"), Type.Literal("at_most"), Type.Literal("exact")]),
		target: Type.Number(),
		tolerance: Type.Number({ minimum: 0 }),
		measurement: Type.Union([
			Type.Literal("public_integration"),
			Type.Literal("fresh_process"),
			Type.Literal("authenticated_artifact"),
			Type.Literal("resource_ledger"),
		]),
		guardIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 }),
	},
	{ additionalProperties: false },
);

const workflowBudgetsSchema = Type.Object(
	{
		tokenLimit: Type.Integer({ minimum: 0 }),
		wallTimeLimitSeconds: Type.Integer({ minimum: 0 }),
		spendLimitMicrounits: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const workflowAuthoritySourceSchema = Type.Object(
	{
		uri: Type.String({ minLength: 1 }),
		objectGeneration: Type.String({ minLength: 1 }),
		objectDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		objectSizeBytes: Type.Integer({ minimum: 1 }),
		localPath: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const workflowProposalSchema = Type.Object(
	{
		objective: Type.String({ minLength: 1 }),
		acceptanceChecks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 }),
		protectedInvariants: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 }),
		boundaryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 }),
		gateIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 }),
		successMetrics: Type.Array(workflowMetricSchema, { minItems: 1, maxItems: 128 }),
		nonGoalIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 }),
		budgets: workflowBudgetsSchema,
		taskGraphSource: Type.Unknown(),
		requestedProfile: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("parallel")])),
		maxWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
		authoritativeSource: Type.Optional(workflowAuthoritySourceSchema),
	},
	{ additionalProperties: false },
);

export type WorkflowBrainstormProposal = Static<typeof workflowProposalSchema>;

export interface WorkflowTaskGraphSourceTask {
	readonly taskId: string;
	readonly objective: string;
	readonly requirementIds: readonly string[];
	readonly completionCriteria: readonly string[];
	readonly dependencyTaskIds: readonly string[];
	readonly boundaryIds: readonly string[];
	readonly inputRefs: readonly string[];
	readonly outputRefs: readonly string[];
	readonly evidencePolicy: {
		readonly kind: string;
		readonly maxBytes: number;
		readonly maxItems: number;
		readonly independent: boolean;
	};
	readonly budget: WorkflowGoalBudgets;
	readonly recovery: "retry" | "replan" | "block";
	/** Cheapest worker tier this task needs. Omitted means standard. */
	readonly computeClass?: WorkflowComputeClass;
	/** Role this task plays, drawn from the closed host vocabulary. Omitted means implementation. */
	readonly role?: WorkflowTaskRole;
	readonly authority: readonly WorkflowAuthorityCapability[];
	readonly ownedPaths?: readonly string[];
	readonly ownedContracts?: readonly string[];
}

export interface WorkflowTaskGraphSource {
	readonly schemaVersion: 1;
	readonly graphRevision: number;
	readonly tasks: readonly WorkflowTaskGraphSourceTask[];
	readonly graphDigest: string;
	readonly recipeCapability?: "dynamic_task_graph" | "builtin_adaptive_prime";
}

export interface WorkflowTaskGraphSourceBinding {
	readonly prompt: string;
	readonly objective: string;
	readonly boundaryIds: readonly string[];
	readonly gateIds: readonly string[];
	readonly acceptanceChecks: readonly string[];
	readonly protectedInvariants: readonly string[];
	readonly successMetrics: readonly WorkflowGoalMetric[];
	readonly nonGoalIds: readonly string[];
	readonly budgets: WorkflowGoalBudgets;
}

export interface WorkflowBrainstormState {
	readonly version: 1;
	readonly draftId: string;
	readonly workflowId: string;
	readonly prompt: string;
	readonly requestedProfile?: "inline" | "parallel";
	readonly maxWorkers?: number;
	readonly previousToolNames: readonly string[];
	readonly status: "draft" | "proposed" | "activated" | "cancelled";
	readonly createdAt: string;
	readonly proposalDigest?: string;
}

export interface WorkflowBrainstormStartInput {
	readonly workflowId: string;
	readonly prompt: string;
	readonly requestedProfile?: "inline" | "parallel";
	readonly maxWorkers?: number;
	readonly previousToolNames: readonly string[];
}

export function createWorkflowBrainstormState(input: WorkflowBrainstormStartInput): WorkflowBrainstormState {
	const prompt = input.prompt.trim();
	if (prompt.length === 0) throw new Error("Workflow brainstorming requires a prompt or current task context.");
	return Object.freeze({
		version: 1,
		draftId: randomUUID(),
		workflowId: input.workflowId,
		prompt,
		...(input.requestedProfile === undefined ? {} : { requestedProfile: input.requestedProfile }),
		...(input.maxWorkers === undefined ? {} : { maxWorkers: input.maxWorkers }),
		previousToolNames: [...input.previousToolNames],
		status: "draft",
		createdAt: new Date().toISOString(),
	});
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCanonicalStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftCodePoints[index] !== rightCodePoints[index]) return leftCodePoints[index]! - rightCodePoints[index]!;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function canonicalStrings(value: unknown, label: string, allowEmpty = true, maxLength = 8_192): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.trim().length > maxLength)
	)
		throw new Error(`workflow_task_graph_source_${label}_invalid`);
	if (!allowEmpty && value.length === 0) throw new Error(`workflow_task_graph_source_${label}_missing`);
	const strings = value.map((item) => item.trim());
	if (new Set(strings).size !== strings.length) throw new Error(`workflow_task_graph_source_${label}_duplicate`);
	return Object.freeze([...strings].sort(compareCanonicalStrings));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		new Set(right).size === right.length &&
		left.every((value) => right.includes(value))
	);
}

function normalizeTaskGraphSourceTask(value: unknown): WorkflowTaskGraphSourceTask {
	if (!isRecord(value)) throw new Error("workflow_task_graph_source_task_invalid");
	const allowedKeys = new Set([
		"taskId",
		"objective",
		"requirementIds",
		"completionCriteria",
		"dependencyTaskIds",
		"boundaryIds",
		"inputRefs",
		"outputRefs",
		"evidencePolicy",
		"budget",
		"recovery",
		"authority",
		"ownedPaths",
		"ownedContracts",
		"computeClass",
		"role",
	]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key)))
		throw new Error("workflow_task_graph_source_task_unknown_field");
	const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
	const objective = typeof value.objective === "string" ? value.objective.trim() : "";
	if (taskId.length === 0 || taskId.length > 128 || objective.length === 0 || objective.length > 8_192)
		throw new Error("workflow_task_graph_source_task_identity_invalid");
	if (taskId === "." || taskId === ".." || taskId.includes("/") || taskId.includes("\\") || taskId.includes("\0"))
		throw new Error("workflow_task_graph_source_task_id_invalid");
	const rawRole = value.role;
	const role = WORKFLOW_TASK_ROLES.find((candidate) => candidate === rawRole);
	if (rawRole !== undefined && role === undefined) throw new Error("workflow_task_graph_source_task_role_invalid");
	const rawComputeClass = value.computeClass;
	const computeClass = WORKFLOW_COMPUTE_CLASSES.find((candidate) => candidate === rawComputeClass);
	if (rawComputeClass !== undefined && computeClass === undefined)
		throw new Error("workflow_task_graph_source_task_compute_class_invalid");
	const requirementIds = canonicalStrings(value.requirementIds, "requirements", false, 256);
	const completionCriteria = canonicalStrings(value.completionCriteria, "completion", false, 8_192);
	const dependencyTaskIds = canonicalStrings(value.dependencyTaskIds, "dependencies", true, 128);
	const boundaryIds = canonicalStrings(value.boundaryIds, "boundaries", false, 256);
	const inputRefs = canonicalStrings(value.inputRefs, "inputs", true, 512);
	const outputRefs = canonicalStrings(value.outputRefs, "outputs", false, 512);
	if (!isRecord(value.evidencePolicy)) throw new Error("workflow_task_graph_source_evidence_policy_missing");
	const evidencePolicy = value.evidencePolicy;
	if (Object.keys(evidencePolicy).some((key) => !["kind", "maxBytes", "maxItems", "independent"].includes(key)))
		throw new Error("workflow_task_graph_source_evidence_policy_unknown_field");
	const evidenceKind = typeof evidencePolicy.kind === "string" ? evidencePolicy.kind : "";
	const evidenceMaxBytes = typeof evidencePolicy.maxBytes === "number" ? evidencePolicy.maxBytes : -1;
	const evidenceMaxItems = typeof evidencePolicy.maxItems === "number" ? evidencePolicy.maxItems : -1;
	const evidenceIndependent = typeof evidencePolicy.independent === "boolean" ? evidencePolicy.independent : false;
	if (
		typeof evidenceKind !== "string" ||
		evidenceKind.trim().length === 0 ||
		evidenceKind.trim().length > 128 ||
		!Number.isSafeInteger(evidenceMaxBytes) ||
		evidenceMaxBytes < 1 ||
		evidenceMaxBytes > 1_000_000 ||
		!Number.isSafeInteger(evidenceMaxItems) ||
		evidenceMaxItems < 1 ||
		evidenceMaxItems > 1_024 ||
		typeof evidenceIndependent !== "boolean"
	)
		throw new Error("workflow_task_graph_source_evidence_policy_invalid");
	if (!isRecord(value.budget)) throw new Error("workflow_task_graph_source_budget_missing");
	const budget = value.budget;
	if (Object.keys(budget).some((key) => !["tokenLimit", "wallTimeLimitSeconds", "spendLimitMicrounits"].includes(key)))
		throw new Error("workflow_task_graph_source_budget_unknown_field");
	const tokenLimit = typeof budget.tokenLimit === "number" ? budget.tokenLimit : -1;
	const wallTimeLimitSeconds = typeof budget.wallTimeLimitSeconds === "number" ? budget.wallTimeLimitSeconds : -1;
	const spendLimitMicrounits = typeof budget.spendLimitMicrounits === "number" ? budget.spendLimitMicrounits : -1;
	if (
		!Number.isSafeInteger(tokenLimit) ||
		tokenLimit < 0 ||
		!Number.isSafeInteger(wallTimeLimitSeconds) ||
		wallTimeLimitSeconds < 0 ||
		wallTimeLimitSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000) ||
		!Number.isSafeInteger(spendLimitMicrounits) ||
		spendLimitMicrounits < 0
	)
		throw new Error("workflow_task_graph_source_budget_invalid");
	if (value.recovery !== "retry" && value.recovery !== "replan" && value.recovery !== "block")
		throw new Error("workflow_task_graph_source_recovery_invalid");
	const authority = canonicalStrings(value.authority, "authority", false, 64) as WorkflowAuthorityCapability[];
	const allowedAuthority = new Set<WorkflowAuthorityCapability>([
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
	if (authority.some((capability) => !allowedAuthority.has(capability)))
		throw new Error("workflow_task_graph_source_authority_invalid");
	const ownedPaths =
		value.ownedPaths === undefined ? [] : canonicalStrings(value.ownedPaths, "owned_paths", true, 512);
	const ownedContracts =
		value.ownedContracts === undefined ? [] : canonicalStrings(value.ownedContracts, "owned_contracts", true, 256);
	return Object.freeze({
		taskId,
		objective,
		requirementIds,
		completionCriteria,
		dependencyTaskIds,
		boundaryIds,
		inputRefs,
		outputRefs,
		evidencePolicy: Object.freeze({
			kind: evidenceKind.trim(),
			maxBytes: evidenceMaxBytes as number,
			maxItems: evidenceMaxItems as number,
			independent: evidenceIndependent as boolean,
		}),
		budget: Object.freeze({
			tokenLimit: tokenLimit as number,
			wallTimeLimitSeconds: wallTimeLimitSeconds as number,
			spendLimitMicrounits: spendLimitMicrounits as number,
		}),
		recovery: value.recovery,
		authority: authority as readonly WorkflowAuthorityCapability[],
		...(ownedPaths.length === 0 ? {} : { ownedPaths }),
		...(ownedContracts.length === 0 ? {} : { ownedContracts }),
		...(computeClass === undefined ? {} : { computeClass }),
		...(role === undefined ? {} : { role }),
	});
}

/**
 * Normalize and validate a finite, content-addressed workflow task graph source.
 *
 * Args:
 * value: Untrusted graph source supplied by the brainstorming model or persisted source artifact.
 * Return: Canonical graph source with a verified graph digest.
 */
export function normalizeWorkflowTaskGraphSource(
	value: unknown,
	binding?: WorkflowTaskGraphSourceBinding,
): WorkflowTaskGraphSource {
	// Models routinely emit a nested object parameter as a JSON string. The encoded object is
	// unambiguous, so decode it once here rather than rejecting an otherwise-valid graph.
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			throw new Error("workflow_task_graph_source_invalid");
		}
	}
	if (!isRecord(value)) throw new Error("workflow_task_graph_source_invalid");
	const allowedKeys = new Set(["schemaVersion", "graphRevision", "tasks", "graphDigest", "recipeCapability"]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key)))
		throw new Error("workflow_task_graph_source_unknown_field");
	if (
		value.schemaVersion !== 1 ||
		typeof value.graphRevision !== "number" ||
		!Number.isSafeInteger(value.graphRevision) ||
		value.graphRevision < 1
	)
		throw new Error("workflow_task_graph_source_revision_invalid");
	const graphRevision = value.graphRevision as number;
	const rawRecipeCapability = value.recipeCapability;
	const recipeCapability =
		typeof rawRecipeCapability === "string" &&
		(rawRecipeCapability === "dynamic_task_graph" || rawRecipeCapability === "builtin_adaptive_prime")
			? rawRecipeCapability
			: undefined;
	if (rawRecipeCapability !== undefined && recipeCapability === undefined)
		throw new Error("workflow_task_graph_source_recipe_capability_invalid");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > 64)
		throw new Error("workflow_task_graph_source_tasks_invalid");
	const tasks = value.tasks
		.map(normalizeTaskGraphSourceTask)
		.sort((left, right) => compareCanonicalStrings(left.taskId, right.taskId));
	const taskIds = new Set<string>();
	for (const task of tasks) {
		if (taskIds.has(task.taskId)) throw new Error("workflow_task_graph_source_task_duplicate");
		taskIds.add(task.taskId);
		if (task.dependencyTaskIds.some((dependencyTaskId) => dependencyTaskId === task.taskId))
			throw new Error("workflow_task_graph_source_self_dependency");
	}
	for (const task of tasks) {
		if (task.dependencyTaskIds.some((dependencyTaskId) => !taskIds.has(dependencyTaskId)))
			throw new Error("workflow_task_graph_source_missing_dependency");
	}
	// The planner chooses the shape; it does not get to omit the checks. Without this a graph of
	// pure implementation nodes silently bypasses verification and adversarial review entirely.
	const declaredRoles = new Set(tasks.map((task) => task.role ?? "implementation"));
	for (const required of WORKFLOW_REQUIRED_TASK_ROLES) {
		if (!declaredRoles.has(required)) throw new Error(`workflow_task_graph_source_missing_role_${required}`);
	}
	// A red-team task must review finished work, not an empty tree. Each task runs in a fresh
	// worker context, so a red-team task that nothing depends on and that depends on real work is
	// exactly a fresh-context review of the completed artifact — which is the one check that
	// reliably caught a contract defect in testing. Without this the role requirement is satisfied
	// vacuously by a red-team task scheduled first.
	const dependedUpon = new Set(tasks.flatMap((task) => task.dependencyTaskIds));
	const terminalRedTeam = tasks.filter(
		(task) => task.role === "red-team" && !dependedUpon.has(task.taskId) && task.dependencyTaskIds.length > 0,
	);
	if (terminalRedTeam.length === 0) throw new Error("workflow_task_graph_source_red_team_not_terminal");
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): void => {
		if (visiting.has(taskId)) throw new Error("workflow_task_graph_source_cycle");
		if (visited.has(taskId)) return;
		visiting.add(taskId);
		for (const dependencyTaskId of byId.get(taskId)?.dependencyTaskIds ?? []) visit(dependencyTaskId);
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const task of tasks) visit(task.taskId);
	const withoutDigest: Omit<WorkflowTaskGraphSource, "graphDigest"> = {
		schemaVersion: 1 as const,
		graphRevision,
		tasks,
		...(recipeCapability === undefined ? {} : { recipeCapability }),
	};
	const graphDigest = digestObject(binding === undefined ? withoutDigest : { ...withoutDigest, binding });
	if (value.graphDigest !== undefined && value.graphDigest !== graphDigest)
		throw new Error("workflow_task_graph_source_digest_invalid");
	return Object.freeze({ ...withoutDigest, graphDigest });
}

export function workflowTaskGraphSourceBindingDigest(binding: WorkflowTaskGraphSourceBinding): string {
	return digestObject(binding);
}

/**
 * Verify that every graph task remains bound to the approved proposal contract.
 *
 * Args:
 * source: Canonical task graph source to check.
 * acceptanceCheckIds: Approved acceptance-check identifiers.
 * protectedInvariantIds: Approved protected-invariant identifiers.
 * Return: Nothing; throws when a task references an unapproved contract item.
 */
export function assertWorkflowTaskGraphSourceContract(input: {
	readonly source: WorkflowTaskGraphSource;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
}): void {
	const acceptanceChecks = new Set(input.acceptanceCheckIds);
	const protectedInvariants = new Set(input.protectedInvariantIds);
	if (acceptanceChecks.size === 0 || protectedInvariants.size === 0)
		throw new Error("workflow_task_graph_source_contract_missing");
	for (const task of input.source.tasks) {
		if (task.requirementIds.some((requirementId) => !acceptanceChecks.has(requirementId)))
			throw new Error("workflow_task_graph_source_requirement_unapproved");
		if (
			task.completionCriteria.some((completionCriterion) => !protectedInvariants.has(completionCriterion)) ||
			task.boundaryIds.some((boundaryId) => !protectedInvariants.has(boundaryId)) ||
			!sameStringSet(task.boundaryIds, [...protectedInvariants])
		)
			throw new Error("workflow_task_graph_source_invariant_unapproved");
	}
}

function createWorkflowTaskGraphSourceBinding(
	state: WorkflowBrainstormState,
	proposal: WorkflowBrainstormProposal,
): WorkflowTaskGraphSourceBinding {
	return {
		prompt: state.prompt,
		objective: proposal.objective.trim(),
		boundaryIds: [...proposal.boundaryIds],
		gateIds: [...proposal.gateIds],
		acceptanceChecks: [...proposal.acceptanceChecks],
		protectedInvariants: [...proposal.protectedInvariants],
		successMetrics: proposal.successMetrics.map((metric) => ({ ...metric, guardIds: [...metric.guardIds] })),
		nonGoalIds: [...proposal.nonGoalIds],
		budgets: { ...proposal.budgets },
	};
}

function deriveWorkflowTaskGraphSource(
	proposal: WorkflowBrainstormProposal,
	binding: WorkflowTaskGraphSourceBinding,
): WorkflowTaskGraphSource {
	if (proposal.taskGraphSource === undefined) throw new Error("workflow_task_graph_source_missing");
	if (
		!sameStringSet(proposal.boundaryIds, proposal.protectedInvariants) ||
		!sameStringSet(proposal.gateIds, proposal.acceptanceChecks)
	)
		throw new Error("workflow_task_graph_source_contract_invalid");
	const source = normalizeWorkflowTaskGraphSource(proposal.taskGraphSource, binding);
	assertWorkflowTaskGraphSourceContract({
		source,
		acceptanceCheckIds: proposal.acceptanceChecks,
		protectedInvariantIds: proposal.protectedInvariants,
	});
	return source;
}

export function isWorkflowBrainstormState(value: unknown): value is WorkflowBrainstormState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		typeof record.draftId === "string" &&
		typeof record.workflowId === "string" &&
		typeof record.prompt === "string" &&
		isStringArray(record.previousToolNames) &&
		(record.status === "draft" ||
			record.status === "proposed" ||
			record.status === "activated" ||
			record.status === "cancelled") &&
		typeof record.createdAt === "string" &&
		(record.proposalDigest === undefined || typeof record.proposalDigest === "string")
	);
}

export function restoreWorkflowBrainstormState(messages: readonly unknown[]): WorkflowBrainstormState | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === WORKFLOW_BRAINSTORM_CUSTOM_TYPE &&
			isWorkflowBrainstormState((message as { details?: unknown }).details)
		) {
			return Object.freeze(structuredClone((message as { details: WorkflowBrainstormState }).details));
		}
	}
	return undefined;
}

export function workflowBrainstormMessage(state: WorkflowBrainstormState): CustomMessage<WorkflowBrainstormState> {
	const content =
		state.status === "draft"
			? "Workflow brainstorming is active; the full task is retained in the immutable source."
			: state.status === "proposed"
				? "Workflow proposal is sealed and awaiting trusted user approval."
				: state.status === "activated"
					? "Workflow proposal was approved and activated."
					: "Workflow brainstorming was cancelled.";
	return {
		role: "custom",
		customType: WORKFLOW_BRAINSTORM_CUSTOM_TYPE,
		content,
		display: false,
		details: state,
		timestamp: Date.now(),
	};
}

const WORKFLOW_BRAINSTORM_TASK_CONTEXT_MAX_LENGTH = 8_192;
const WORKFLOW_BRAINSTORM_TASK_CONTEXT_OMISSION = "\n[... full task retained in immutable source]";

function compactWorkflowTaskContext(prompt: string): string {
	const taskContext = prompt.trim();
	if (taskContext.length <= WORKFLOW_BRAINSTORM_TASK_CONTEXT_MAX_LENGTH) return taskContext;
	const prefixLength = WORKFLOW_BRAINSTORM_TASK_CONTEXT_MAX_LENGTH - WORKFLOW_BRAINSTORM_TASK_CONTEXT_OMISSION.length;
	return `${taskContext.slice(0, prefixLength)}${WORKFLOW_BRAINSTORM_TASK_CONTEXT_OMISSION}`;
}

export function workflowBrainstormPrompt(state: WorkflowBrainstormState): string {
	return [
		"Start the workflow completeness preflight for the task below.",
		"Use conversational brainstorming: inspect the supplied context, identify only material unknowns, and ask one concise question at a time.",
		"Read the workspace before asking: list files, read the exact sources, tests, and configuration the objective names, and check recent history. Ask the user only for decisions the repository cannot answer.",
		"When you do need a decision only the user can make, ask it as your final message and stop. Never call a tool while waiting for an answer: repeating no-op tool calls to pass the time cannot produce one, and it burns the turn and the request budget.",
		"This phase is read-only. Do not edit, create, delete, move, or format any file, do not run installers or migrations, and do not run commands with side effects outside the workspace. Nothing is approved yet.",
		"Reconnaissance findings belong in the proposal's task objectives and completion criteria, not in a separate report.",
		"Do not propose architecture or implementation when a smaller outcome definition is sufficient.",
		"When objective, causal metrics, protected invariants, non-goals, budgets, boundaries, and gates are complete, call workflow_propose exactly once.",
		"Derive a finite taskGraphSource with prompt-specific task IDs, objectives, requirementIds, completionCriteria, dependencies, neutral boundaries, inputs, outputs, evidence policy, budget, recovery, and authority; do not reuse a fixed workflow stage list.",
		"taskGraphSource is mandatory; never omit it or rely on a host-generated fallback graph.",
		'Set computeClass per task to the cheapest tier that can do it: "cheap" for reading, searching, and summarizing; "standard" for ordinary implementation and verification; "deep" only for adjudication, synthesis, and adversarial review. Omit it when unsure.',
		"Divide fanned-out work by charter rather than repeating it: sibling tasks with no dependency between them must have distinct objectives, not the same objective run twice.",
		'Set role per task from exactly this list: recon, lens, verify, verification, synthesize, red-team, attack, architect, judge, unify, edge-test, implementation, integration, planning, design, review. The graph is REJECTED unless at least one task has role "verification" and at least one has role "red-team" — a check task depends on the work it checks and must not own the same paths. Give checking tasks authority ["read_workspace"] only, and give every task at least one outputRef (an evidence artifact path is fine for a checking task).',
		"Leave taskGraphSource.graphDigest unset; the host binds it to the full prompt and approved contract before sealing.",
		"Omit authoritativeSource entirely. The host derives it from this session; supplying your own URI is rejected as workflow_task_graph_source_requires_session_source.",
		"Cross-reference rule, the most common cause of rejection: every task's requirementIds must all appear in acceptanceChecks; every task's completionCriteria must all appear in protectedInvariants; and every task's boundaryIds must equal protectedInvariants exactly. Reuse those exact identifiers, do not invent parallel ones and do not put prose in completionCriteria.",
		'Worked example whose identifiers line up. acceptanceChecks ["check-test-passes"], protectedInvariants ["inv-test-file-unmodified"], and taskGraphSource {"schemaVersion":1,"graphRevision":1,"tasks":[{"taskId":"fix-add","objective":"Change add() in calc.py to return a + b","requirementIds":["check-test-passes"],"completionCriteria":["inv-test-file-unmodified"],"dependencyTaskIds":[],"boundaryIds":["inv-test-file-unmodified"],"inputRefs":[],"outputRefs":["calc.py"],"evidencePolicy":{"kind":"command","maxBytes":4096,"maxItems":4,"independent":true},"budget":{"tokenLimit":20000,"wallTimeLimitSeconds":300,"spendLimitMicrounits":0},"recovery":"retry","authority":["read_workspace"],"computeClass":"standard","role":"implementation"},{"taskId":"verify-add","objective":"Run test_calc.py and confirm it passes","requirementIds":["check-test-passes"],"completionCriteria":["inv-test-file-unmodified"],"dependencyTaskIds":["fix-add"],"boundaryIds":["inv-test-file-unmodified"],"inputRefs":[],"outputRefs":["artifacts/verify-add.json"],"evidencePolicy":{"kind":"command","maxBytes":4096,"maxItems":4,"independent":true},"budget":{"tokenLimit":8000,"wallTimeLimitSeconds":120,"spendLimitMicrounits":0},"recovery":"retry","authority":["read_workspace"],"computeClass":"standard","role":"verification"},{"taskId":"attack-add","objective":"Attempt to break add() with edge-case inputs and report defects","requirementIds":["check-test-passes"],"completionCriteria":["inv-test-file-unmodified"],"dependencyTaskIds":["verify-add"],"boundaryIds":["inv-test-file-unmodified"],"inputRefs":[],"outputRefs":["artifacts/attack-add.json"],"evidencePolicy":{"kind":"command","maxBytes":4096,"maxItems":4,"independent":true},"budget":{"tokenLimit":8000,"wallTimeLimitSeconds":120,"spendLimitMicrounits":0},"recovery":"retry","authority":["read_workspace"],"computeClass":"deep","role":"red-team"}]}',
		"Keep the proposal compact. acceptanceChecks and protectedInvariants are stable identifiers; bind detailed semantics through the immutable task source and objective.",
		"boundaryIds must exactly equal protectedInvariants, gateIds must exactly equal acceptanceChecks, and metric requirementId/guardIds must reference those exact identifiers.",
		"Do not claim approval and do not perform task work; the host will separately request trusted user approval.",
		`Task context: ${compactWorkflowTaskContext(state.prompt)}`,
	].join("\n");
}

interface SealedWorkflowSourceDocument {
	readonly schemaVersion: 1;
	readonly draftId: string;
	readonly prompt: string;
	readonly objective: string;
	readonly boundaryIds: readonly string[];
	readonly gateIds: readonly string[];
	readonly acceptanceChecks: readonly string[];
	readonly protectedInvariants: readonly string[];
	readonly successMetrics: readonly WorkflowGoalMetric[];
	readonly nonGoalIds: readonly string[];
	readonly budgets: WorkflowGoalBudgets;
	readonly taskGraphSource: WorkflowTaskGraphSource;
	readonly taskGraphDigest: string;
	readonly taskGraphBindingDigest: string;
}

async function persistSessionGoalSource(
	artifactRoot: string,
	state: WorkflowBrainstormState,
	proposal: WorkflowBrainstormProposal,
): Promise<WorkflowGoalAuthoritySourceRequest> {
	const binding = createWorkflowTaskGraphSourceBinding(state, proposal);
	const taskGraphSource = deriveWorkflowTaskGraphSource(proposal, binding);
	const document: SealedWorkflowSourceDocument = {
		schemaVersion: 1,
		draftId: state.draftId,
		prompt: state.prompt,
		objective: proposal.objective.trim(),
		boundaryIds: [...proposal.boundaryIds],
		gateIds: [...proposal.gateIds],
		acceptanceChecks: [...proposal.acceptanceChecks],
		protectedInvariants: [...proposal.protectedInvariants],
		successMetrics: proposal.successMetrics.map((metric) => ({ ...metric, guardIds: [...metric.guardIds] })),
		nonGoalIds: [...proposal.nonGoalIds],
		budgets: { ...proposal.budgets },
		taskGraphSource,
		taskGraphDigest: taskGraphSource.graphDigest,
		taskGraphBindingDigest: workflowTaskGraphSourceBindingDigest(binding),
	};
	const bytes = canonicalJsonBytes(document);
	const objectDigest = sha256Hex(bytes);
	const directory = join(artifactRoot, "workflow-goal-sources");
	const filename = `sha256=${objectDigest}.json`;
	const path = join(directory, filename);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	} catch (error) {
		const existing = await readFile(path).catch(() => undefined);
		if (existing === undefined || !Buffer.from(existing).equals(Buffer.from(bytes))) throw error;
	}
	return {
		kind: "immutable_object",
		uri: `session-artifact://workflow-goal-sources/${filename}`,
		objectGeneration: "1",
		objectDigest,
		objectSizeBytes: bytes.byteLength,
		parsedObjective: document.objective,
		boundaryIds: document.boundaryIds,
		gateIds: document.gateIds,
	};
}

function workflowTaskGraphSourceBindingFromDocument(document: Record<string, unknown>): WorkflowTaskGraphSourceBinding {
	if (
		typeof document.prompt !== "string" ||
		typeof document.objective !== "string" ||
		!Array.isArray(document.boundaryIds) ||
		!Array.isArray(document.gateIds) ||
		!Array.isArray(document.acceptanceChecks) ||
		!Array.isArray(document.protectedInvariants) ||
		!Array.isArray(document.successMetrics) ||
		!Array.isArray(document.nonGoalIds) ||
		!isRecord(document.budgets)
	)
		throw new Error("workflow_task_graph_source_document_invalid");
	return {
		prompt: document.prompt,
		objective: document.objective,
		boundaryIds: document.boundaryIds as readonly string[],
		gateIds: document.gateIds as readonly string[],
		acceptanceChecks: document.acceptanceChecks as readonly string[],
		protectedInvariants: document.protectedInvariants as readonly string[],
		successMetrics: document.successMetrics as readonly WorkflowGoalMetric[],
		nonGoalIds: document.nonGoalIds as readonly string[],
		budgets: document.budgets as unknown as WorkflowGoalBudgets,
	};
}

/**
 * Read and verify the task graph source sealed beside a session goal source.
 *
 * Args:
 * artifactRoot: Private persisted session-artifact root.
 * source: Goal source reference whose object digest and size are trusted by the host.
 * Return: Verified task graph source, or undefined for non-session goal sources.
 */
export async function readWorkflowTaskGraphSource(input: {
	readonly artifactRoot: string;
	readonly source: Pick<
		WorkflowGoalAuthoritySourceRequest,
		"uri" | "objectGeneration" | "objectDigest" | "objectSizeBytes"
	>;
	readonly expectedBinding?: WorkflowTaskGraphSourceBinding;
}): Promise<WorkflowTaskGraphSource | undefined> {
	const match = SESSION_WORKFLOW_GOAL_SOURCE_URI.exec(input.source.uri);
	if (match === null) return undefined;
	if (input.source.objectGeneration !== "1" || match[1] !== input.source.objectDigest)
		throw new Error("workflow_task_graph_source_binding_invalid");
	const path = join(input.artifactRoot, "workflow-goal-sources", `sha256=${input.source.objectDigest}.json`);
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("workflow_task_graph_source_missing", { cause: error });
		throw error;
	}
	if (bytes.byteLength !== input.source.objectSizeBytes || sha256Hex(bytes) !== input.source.objectDigest)
		throw new Error("workflow_task_graph_source_digest_invalid");
	let parsed: unknown;
	try {
		parsed = parseCanonicalJsonBytes(bytes);
	} catch (error) {
		throw new Error("workflow_task_graph_source_parse_invalid", { cause: error });
	}
	if (!isRecord(parsed)) throw new Error("workflow_task_graph_source_document_invalid");
	if (!isRecord(parsed.taskGraphSource)) throw new Error("workflow_task_graph_source_document_invalid");
	const binding = workflowTaskGraphSourceBindingFromDocument(parsed);
	if (
		typeof parsed.taskGraphBindingDigest !== "string" ||
		parsed.taskGraphBindingDigest !== workflowTaskGraphSourceBindingDigest(binding)
	)
		throw new Error("workflow_task_graph_source_binding_invalid");
	if (
		input.expectedBinding !== undefined &&
		workflowTaskGraphSourceBindingDigest(input.expectedBinding) !== parsed.taskGraphBindingDigest
	)
		throw new Error("workflow_task_graph_source_binding_invalid");
	const taskGraphSource = normalizeWorkflowTaskGraphSource(parsed.taskGraphSource, binding);
	if (parsed.taskGraphDigest !== taskGraphSource.graphDigest)
		throw new Error("workflow_task_graph_source_digest_invalid");
	return taskGraphSource;
}

export async function workflowStartRequestFromProposal(input: {
	readonly artifactRoot: string;
	readonly state: WorkflowBrainstormState;
	readonly proposal: WorkflowBrainstormProposal;
}): Promise<WorkflowStartRequest> {
	const proposal = input.proposal;
	const binding = createWorkflowTaskGraphSourceBinding(input.state, proposal);
	let authoritativeSource: WorkflowGoalAuthoritySourceRequest;
	if (proposal.authoritativeSource !== undefined) {
		if (SESSION_WORKFLOW_GOAL_SOURCE_URI.test(proposal.authoritativeSource.uri) === false)
			throw new Error("workflow_task_graph_source_requires_session_source");
		const taskGraphSource = await readWorkflowTaskGraphSource({
			artifactRoot: input.artifactRoot,
			source: proposal.authoritativeSource,
			expectedBinding: binding,
		});
		if (taskGraphSource === undefined) throw new Error("workflow_task_graph_source_missing");
		const expectedTaskGraphSource = deriveWorkflowTaskGraphSource(proposal, binding);
		if (expectedTaskGraphSource.graphDigest !== taskGraphSource.graphDigest)
			throw new Error("workflow_task_graph_source_digest_invalid");
		assertWorkflowTaskGraphSourceContract({
			source: taskGraphSource,
			acceptanceCheckIds: proposal.acceptanceChecks,
			protectedInvariantIds: proposal.protectedInvariants,
		});
		authoritativeSource = {
			kind: "immutable_object",
			uri: proposal.authoritativeSource.uri,
			objectGeneration: proposal.authoritativeSource.objectGeneration,
			objectDigest: proposal.authoritativeSource.objectDigest,
			objectSizeBytes: proposal.authoritativeSource.objectSizeBytes,
			parsedObjective: proposal.objective.trim(),
			boundaryIds: [...proposal.boundaryIds],
			gateIds: [...proposal.gateIds],
		};
	} else {
		authoritativeSource = await persistSessionGoalSource(input.artifactRoot, input.state, proposal);
		const taskGraphSource = await readWorkflowTaskGraphSource({
			artifactRoot: input.artifactRoot,
			source: authoritativeSource,
			expectedBinding: binding,
		});
		if (taskGraphSource === undefined) throw new Error("workflow_task_graph_source_missing");
	}
	return {
		workflowId: input.state.workflowId,
		objective: proposal.objective.trim(),
		requestedProfile: proposal.requestedProfile ?? input.state.requestedProfile,
		maxWorkers: proposal.maxWorkers ?? input.state.maxWorkers,
		acceptanceChecks: [...proposal.acceptanceChecks],
		protectedInvariants: [...proposal.protectedInvariants],
		goalContract: {
			authoritativeSource,
			successMetrics: proposal.successMetrics.map((metric) => ({ ...metric, guardIds: [...metric.guardIds] })),
			nonGoalIds: [...proposal.nonGoalIds],
			budgets: { ...proposal.budgets },
		},
	};
}

export function createWorkflowProposalTool(input: {
	readonly propose: (proposal: WorkflowBrainstormProposal) => Promise<{ readonly status: string }>;
}): ToolDefinition<typeof workflowProposalSchema> {
	return {
		name: WORKFLOW_PROPOSE_TOOL_NAME,
		label: "workflow proposal",
		description:
			"Seal one complete workflow proposal after conversational brainstorming. This does not approve or execute the workflow.",
		parameters: workflowProposalSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, proposal): Promise<AgentToolResult<undefined>> => {
			const result = await input.propose(proposal);
			return {
				content: [{ type: "text", text: `Workflow proposal sealed with status ${result.status}.` }],
				details: undefined,
			};
		},
	};
}

export function workflowProposalDigest(proposal: WorkflowBrainstormProposal): string {
	return createHash("sha256").update(canonicalJsonBytes(proposal)).digest("hex");
}
