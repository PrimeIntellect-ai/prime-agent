import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_TASK_GRAPH_SCHEMA_VERSION = 1;
export const AGENT_TASK_TEXT_MAX_LENGTH = 4_000;
export const AGENT_TASK_LIST_MAX_ITEMS = 256;
export const AGENT_TASK_CLAIM_MAX_ITEMS = 5_000;
export const AGENT_TASK_RESULT_MAX_BYTES = 64 * 1024;
export const AGENT_TASK_HANDOFF_MAX_BYTES = 32 * 1024;
export const AGENT_TASK_CONTEXT_HANDOFF_MAX_ITEMS = 16;
export const AGENT_TASK_CONTEXT_EVIDENCE_MAX_ITEMS = 64;
export const AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS = 100;
export const AGENT_TASK_SNAPSHOT_COMPACT_EVENT_THRESHOLD = 128;
export const AGENT_TASK_SNAPSHOT_COMPACT_BYTE_THRESHOLD = 512 * 1024;
/** Immutable runtime capability advertisement for hosts that configure task-graph policies. */
export const AGENT_TASK_GRAPH_POLICY_CAPABILITIES = Object.freeze({
	version: 3,
	graphScopedExecutionProfile: true,
	constrainedCompletionCorrection: true,
	boundedDelegatedTaskConvergence: true,
	durableTaskAttempts: true,
	durableTaskHandoffs: true,
	sharedTaskEvidence: true,
	historicalDelegationCoverage: true,
	sharedTaskBudget: true,
} as const);

export type AgentTaskStatus =
	| "pending"
	| "starting"
	| "running"
	| "blocked"
	| "completed"
	| "cancelled"
	| "interrupted";

export type AgentTaskDelegationState = "retained" | "partially_delegated" | "fully_delegated";

export interface AgentTaskResourceClaim {
	namespace: string;
	key: string;
	metadata?: Record<string, unknown>;
}

export interface AgentTaskContextEnvelope {
	rootObjective: string;
	rootContext?: Record<string, unknown>;
	rootContextDescriptor?: AgentTaskRootContextDescriptor;
	taskId: string;
	parentTaskId?: string;
	lineage: string[];
	scope: string;
	exclusiveClaims: AgentTaskResourceClaim[];
	sharedClaims: AgentTaskResourceClaim[];
	exclusions: AgentTaskResourceClaim[];
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	evidenceRefs: string[];
	plan?: AgentTaskPlan;
	currentAttempt?: AgentTaskAttempt;
	relevantHandoffs: AgentTaskHandoff[];
	relevantEvidence: AgentTaskEvidence[];
	sharedBudget?: AgentTaskSharedBudget;
	unresolvedQuestions: string[];
	verificationExpectations: string[];
	resultSchema?: Record<string, unknown>;
	version: number;
}

export interface AgentTaskPlan {
	mode: "leaf" | "coordinator";
	rationale: string;
	boundaries: string[];
	expectedEvidence: string[];
	recordedAt: string;
}

export interface AgentTaskEvidenceInput {
	kind: string;
	subjects: string[];
	/** Resource claims whose contents this evidence operation will inspect. */
	claims?: AgentTaskResourceClaim[];
	contentDigest: string;
	summary?: string;
	artifactRef?: string;
}

export interface AgentTaskEvidence extends AgentTaskEvidenceInput {
	id: string;
	producedByTaskId: string;
	producedByAttemptId: string;
	createdAt: string;
}

export interface AgentTaskHandoffInput {
	summary: string;
	inspectedClaims?: AgentTaskResourceClaim[];
	remainingClaims?: AgentTaskResourceClaim[];
	evidenceIds?: string[];
	candidateFindings?: unknown[];
	rejectedHypotheses?: string[];
	verification?: unknown[];
	unresolvedQuestions?: string[];
	recommendedNextScopes?: string[];
}

export interface AgentTaskHandoff {
	summary: string;
	inspectedClaims: AgentTaskResourceClaim[];
	remainingClaims: AgentTaskResourceClaim[];
	evidenceIds: string[];
	candidateFindings: unknown[];
	rejectedHypotheses: string[];
	verification: unknown[];
	unresolvedQuestions: string[];
	recommendedNextScopes: string[];
	createdAt: string;
}

export interface AgentTaskAttempt {
	id: string;
	agentId: string;
	status: "pending" | "running" | "completed" | "interrupted" | "cancelled" | "replaced";
	predecessorAttemptId?: string;
	startedAt?: string;
	endedAt?: string;
	handoff?: AgentTaskHandoff;
}

export interface AgentTaskRootContextDescriptor {
	sha256: string;
	byteLength: number;
}

export interface AgentTaskGraphHealth {
	status: "healthy" | "degraded" | "failed";
	error?: string;
}

export interface AgentTaskProgress {
	summary: string;
	evidenceRefs: string[];
	completedQuestions: string[];
	updatedAt: string;
}

export interface AgentTaskConvergenceState {
	phase: "exploring" | "finalizing";
	explorationToolCalls: number;
	toolCallsWithoutEvidence: number;
	finalizingToolCalls: number;
	seenEvidenceRefs: string[];
}

export interface AgentTaskConvergenceUpdate {
	state: AgentTaskConvergenceState;
	enteredFinalizing: boolean;
	exhausted: boolean;
	remainingFinalizationToolCalls: number;
}

export interface AgentTaskSharedBudget {
	maxTotalTokens: number;
	usedTokens: number;
	remainingTokens: number;
	exhausted: boolean;
}

export interface AgentTaskResult {
	summary: string;
	verification: unknown[];
	candidateFindings: unknown[];
	unresolvedQuestions: string[];
	coverageGaps: unknown[];
	evidenceRefs: string[];
	data?: Record<string, unknown>;
}

export interface AgentTaskGap {
	id: string;
	kind: "coverage" | "context" | "dependency" | "other";
	description: string;
	neededInformation?: string;
	status: "open" | "resolved" | "declined";
	reportedByAgentId: string;
	resolution?: string;
	evidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
}

export interface AgentTaskResumeRequest {
	id: string;
	taskId: string;
	ownerAgentId: string;
	/** Missing on pre-0.7.7 snapshots, which are gap-resolution resumes. */
	reason?: "gap_resolution" | "descendants_terminal" | "supervision_required";
	gapIds: string[];
	gapCount: number;
	status: "pending" | "admitted";
	requestedAt: string;
	admittedAt?: string;
}

export interface AgentTaskResumeDispatch extends AgentTaskResumeRequest {
	gaps: AgentTaskGap[];
	/** Missing on dispatches produced by pre-supervision runtimes. */
	supervisionAlerts?: AgentTaskSupervisionAlert[];
	context: AgentTaskContextEnvelope;
}

export interface AgentTaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AgentTaskUsageAttribution {
	agentId: string;
	agentKind?: "root" | "child";
	model: string;
	calls: number;
	usage: AgentTaskUsage;
}

export interface AgentTask {
	id: string;
	parentTaskId?: string;
	createdByAgentId: string;
	ownerAgentId: string;
	objective: string;
	scope: string;
	exclusiveClaims: AgentTaskResourceClaim[];
	sharedClaims: AgentTaskResourceClaim[];
	exclusions: AgentTaskResourceClaim[];
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	verificationExpectations: string[];
	resultSchema?: Record<string, unknown>;
	delegationReason?: string;
	contractKey?: string;
	predecessorTaskId?: string;
	repeatReason?: "remaining_scope" | "recorded_gap" | "contradiction" | "new_cross_boundary_question";
	plan?: AgentTaskPlan;
	evidence: AgentTaskEvidence[];
	attempts: AgentTaskAttempt[];
	status: AgentTaskStatus;
	delegationState: AgentTaskDelegationState;
	progress?: AgentTaskProgress;
	convergence?: AgentTaskConvergenceState;
	result?: AgentTaskResult;
	gaps: AgentTaskGap[];
	resumeRequest?: AgentTaskResumeRequest;
	usage: AgentTaskUsage;
	usageAttributions: AgentTaskUsageAttribution[];
	childAgentId?: string;
	reclaimedAt?: string;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface AgentTaskGraphSnapshot {
	schemaVersion: typeof AGENT_TASK_GRAPH_SCHEMA_VERSION;
	graphId: string;
	rootTaskId: string;
	rootAgentId: string;
	rootContext?: Record<string, unknown>;
	inheritedContext?: Record<string, unknown>;
	version: number;
	tasks: AgentTask[];
}

export interface AgentTaskGraphPage {
	graphId: string;
	rootTaskId: string;
	rootAgentId: string;
	version: number;
	totalTasks: number;
	offset: number;
	tasks: AgentTask[];
}

export interface AgentTaskSupervisionAlert {
	taskId: string;
	ownerAgentId: string;
	kind:
		| "blocked_gap"
		| "waiting_for_descendants"
		| "resume_pending"
		| "stalled"
		| "ready_for_synthesis"
		| "reported_uncertainty";
	message: string;
	gapId?: string;
	directParentTaskId?: string;
	ageMs?: number;
}

export interface AgentTaskRootInput {
	id?: string;
	ownerAgentId: string;
	objective: string;
	scope?: string;
	exclusiveClaims?: AgentTaskResourceClaim[];
	sharedClaims?: AgentTaskResourceClaim[];
	exclusions?: AgentTaskResourceClaim[];
	questions?: string[];
	invariants?: string[];
	knownDecisions?: string[];
	dependencies?: string[];
	verificationExpectations?: string[];
	resultSchema?: Record<string, unknown>;
	rootContext?: Record<string, unknown>;
	/** Bounded root-context projection inherited by every descendant prompt. */
	inheritedContext?: Record<string, unknown>;
}

export interface AgentTaskDelegationInput {
	id?: string;
	objective: string;
	scope: string;
	exclusiveClaims?: AgentTaskResourceClaim[];
	sharedClaims?: AgentTaskResourceClaim[];
	exclusions?: AgentTaskResourceClaim[];
	questions?: string[];
	invariants?: string[];
	knownDecisions?: string[];
	dependencies?: string[];
	verificationExpectations?: string[];
	resultSchema?: Record<string, unknown>;
	delegationReason: string;
	contractKey?: string;
	predecessorTaskId?: string;
	repeatReason?: "remaining_scope" | "recorded_gap" | "contradiction" | "new_cross_boundary_question";
}

export interface AgentTaskDelegationValidationRequest {
	parent: Readonly<AgentTask>;
	child: Readonly<AgentTaskDelegationInput>;
	snapshot: Readonly<AgentTaskGraphSnapshot>;
}

export interface AgentTaskCompletionValidationRequest {
	task: Readonly<AgentTask>;
	result: Readonly<AgentTaskResult>;
	snapshot: Readonly<AgentTaskGraphSnapshot>;
}

export interface AgentTaskGraphPolicy {
	requireExclusiveClaims?: boolean;
	requireDelegatedTaskPlan?: boolean;
	requireDelegationContractKey?: boolean;
	/** Optional host-owned token budget shared by the complete task graph. */
	maxTotalTokens?: number;
	validateDelegation?: (request: AgentTaskDelegationValidationRequest) => void;
	validateCompletion?: (request: AgentTaskCompletionValidationRequest) => void;
	/** Optional host policy for long-running delegated tasks. Prime observes
	 * durable evidence progress rather than imposing a task token budget. */
	delegatedTaskConvergence?: {
		maxToolCallsWithoutEvidence: number;
		maxToolCallsAfterSteer: number;
		/** Optional emergency ceiling. Omit to converge only when evidence stops advancing. */
		maxExplorationToolCalls?: number;
	};
	/** Opts delegated tasks into one correction turn after an automatic
	 * completion fails host validation. The correction must explicitly submit
	 * a structured result or report a gap within three action attempts. Prime
	 * preserves the automatic completion's summary, so a validateCompletion
	 * policy used with correction must not reject or require changes to summary;
	 * it may reject only fields the correction turn is allowed to supply. */
	delegatedTaskCompletionCorrection?: boolean;
	/** Applies a restricted Linux execution profile to every task session's
	 * IPython kernel. In-process Python, including file writes, remains available.
	 * Seccomp blocks execve/execveat and ptrace/process_vm_* cross-process memory
	 * syscalls, while a Python audit hook rejects conventional process-creation
	 * APIs. This is an execution profile, not a complete hostile-process sandbox.
	 * Kernel startup fails closed unless supported Linux seccomp enforcement
	 * can be installed. Other host and extension execution surfaces are outside
	 * this profile. */
	executionProfile?: "inspection_only";
}

export interface OpenAgentTaskGraphOptions {
	directory: string;
	root: AgentTaskRootInput;
	policy?: AgentTaskGraphPolicy;
}

interface AgentTaskGraphEvent {
	schemaVersion: typeof AGENT_TASK_GRAPH_SCHEMA_VERSION;
	graphId: string;
	graphVersion: number;
	type: string;
	actorAgentId: string;
	taskIds: string[];
	tasks: AgentTask[];
	rootAgentId?: string;
	usageDelta?: {
		taskId: string;
		usage: AgentTaskUsage;
		attribution?: Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model">;
		taskVersion: number;
		updatedAt: string;
	};
	at: string;
}

const ACTIVE_TASK_STATUSES = new Set<AgentTaskStatus>(["pending", "starting", "running", "blocked"]);

export class AgentTaskGraphError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentTaskGraphError";
	}
}

export class AgentTaskGraph {
	private readonly snapshotPath: string;
	private readonly eventsPath: string;
	private readonly policy: AgentTaskGraphPolicy;
	private state: AgentTaskGraphSnapshot;
	private eventsSinceSnapshot = 0;
	private bytesSinceSnapshot = 0;
	private degradedError?: Error;
	private fatalError?: Error;
	private readonly changeWaiters = new Set<() => void>();

	private constructor(options: OpenAgentTaskGraphOptions, policy: AgentTaskGraphPolicy) {
		this.policy = policy;
		mkdirSync(options.directory, { recursive: true, mode: 0o700 });
		this.snapshotPath = join(options.directory, "task-graph.snapshot.json");
		this.eventsPath = join(options.directory, "task-graph.events.jsonl");
		this.state = this.loadOrCreate(options.root);
		this.recover(options.root.ownerAgentId);
	}

	static open(options: OpenAgentTaskGraphOptions): AgentTaskGraph {
		return new AgentTaskGraph(options, normalizeAgentTaskGraphPolicy(options.policy));
	}

	get rootTaskId(): string {
		return this.state.rootTaskId;
	}

	get rootAgentId(): string {
		return this.state.rootAgentId;
	}

	get version(): number {
		return this.state.version;
	}

	getHealth(): AgentTaskGraphHealth {
		if (this.fatalError) return { status: "failed", error: this.fatalError.message };
		if (this.degradedError) return { status: "degraded", error: this.degradedError.message };
		return { status: "healthy" };
	}

	/** Persist a compact recovery point and rotate journal entries already represented by it. */
	checkpoint(): void {
		this.assertWritable();
		this.compactSnapshot(true);
	}

	rebindRootAgent(ownerAgentId: string): AgentTask {
		const normalizedOwner = normalizeIdentifier(ownerAgentId, "ownerAgentId");
		const root = this.findTask(this.state.rootTaskId);
		if (
			this.state.rootAgentId === normalizedOwner &&
			root.ownerAgentId === normalizedOwner &&
			(!root.resumeRequest || root.resumeRequest.ownerAgentId === normalizedOwner)
		)
			return clone(root);
		const next = touchTask({
			...root,
			ownerAgentId: normalizedOwner,
			attempts: rebindActiveAttempt(root, normalizedOwner, "Root session rebound"),
			...(root.resumeRequest ? { resumeRequest: { ...root.resumeRequest, ownerAgentId: normalizedOwner } } : {}),
		});
		this.commit("graph.root_rebound", normalizedOwner, [next], { rootAgentId: normalizedOwner });
		return clone(next);
	}

	getTask(taskId: string): AgentTask {
		const task = this.findTask(taskId);
		return clone(task);
	}

	getCurrentTask(taskId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		if (task.ownerAgentId !== callerAgentId && callerAgentId !== this.state.rootAgentId) {
			throw new AgentTaskGraphError(`agent ${callerAgentId} does not own task ${taskId}`);
		}
		return clone(task);
	}

	getSnapshot(options: { offset?: number; limit?: number } = {}): AgentTaskGraphPage {
		const offset = normalizeNonNegativeInteger(options.offset ?? 0, "offset");
		const limit = normalizeIntegerInRange(
			options.limit ?? AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS,
			"limit",
			1,
			AGENT_TASK_SNAPSHOT_PAGE_MAX_ITEMS,
		);
		const tasks = [...this.state.tasks].sort(compareTasks);
		return {
			graphId: this.state.graphId,
			rootTaskId: this.state.rootTaskId,
			rootAgentId: this.state.rootAgentId,
			version: this.state.version,
			totalTasks: tasks.length,
			offset,
			tasks: clone(tasks.slice(offset, offset + limit)),
		};
	}

	getSupervisionAlerts(options: { now?: number; stallAfterMs?: number } = {}): AgentTaskSupervisionAlert[] {
		const now = options.now ?? Date.now();
		const stallAfterMs = normalizeIntegerInRange(
			options.stallAfterMs ?? 5 * 60_000,
			"stallAfterMs",
			1_000,
			24 * 60 * 60_000,
		);
		const alerts: AgentTaskSupervisionAlert[] = [];
		for (const task of this.state.tasks) {
			const parent = task.parentTaskId ? this.findTask(task.parentTaskId) : undefined;
			if (
				task.status === "pending" &&
				task.resumeRequest?.status === "pending" &&
				task.resumeRequest.reason === "descendants_terminal" &&
				this.hasActiveDescendants(task.id)
			) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "waiting_for_descendants",
					message: "Coordinator is suspended until its delegated descendants are terminal",
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
			if (
				task.status === "pending" &&
				task.resumeRequest?.status === "pending" &&
				(task.resumeRequest.reason !== "descendants_terminal" || !this.hasActiveDescendants(task.id))
			) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "resume_pending",
					message:
						task.resumeRequest.reason === "supervision_required"
							? "A descendant gap is waiting for this supervisor to admit a follow-up turn"
							: "Resolved task gap is waiting for its owner runtime to admit a follow-up turn",
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
			for (const gap of task.gaps.filter((candidate) => candidate.status === "open")) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "blocked_gap",
					message: gap.description,
					gapId: gap.id,
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
			if (task.status === "running") {
				const lastActivity = Date.parse(task.progress?.updatedAt ?? task.updatedAt);
				const ageMs = Number.isFinite(lastActivity) ? Math.max(0, now - lastActivity) : stallAfterMs;
				if (ageMs >= stallAfterMs) {
					alerts.push({
						taskId: task.id,
						ownerAgentId: task.ownerAgentId,
						kind: "stalled",
						message: `No durable task progress for ${ageMs}ms`,
						...(parent ? { directParentTaskId: parent.id } : {}),
						ageMs,
					});
				}
				const children = this.childrenOf(task.id);
				if (
					task.delegationState !== "retained" &&
					children.length > 0 &&
					children.every((child) => !ACTIVE_TASK_STATUSES.has(child.status))
				) {
					alerts.push({
						taskId: task.id,
						ownerAgentId: task.ownerAgentId,
						kind: "ready_for_synthesis",
						message: "All delegated child tasks are terminal; synthesize their results and finish this task",
						...(parent ? { directParentTaskId: parent.id } : {}),
					});
				}
			}
			if (
				task.status === "completed" &&
				((task.result?.unresolvedQuestions.length ?? 0) > 0 || (task.result?.coverageGaps.length ?? 0) > 0)
			) {
				alerts.push({
					taskId: task.id,
					ownerAgentId: task.ownerAgentId,
					kind: "reported_uncertainty",
					message: "Completed task reported unresolved questions or coverage gaps",
					...(parent ? { directParentTaskId: parent.id } : {}),
				});
			}
		}
		return alerts;
	}

	contextEnvelope(taskId: string): AgentTaskContextEnvelope {
		const task = this.findTask(taskId);
		const root = this.findTask(this.state.rootTaskId);
		const sharedBudget = this.getSharedBudget();
		const handoffs = this.handoffsForTask(task);
		const taskClaims = [...task.exclusiveClaims, ...task.sharedClaims];
		const allEvidence = this.state.tasks.flatMap((candidate) => candidate.evidence);
		const claimEvidence = allEvidence.filter((evidence) =>
			(evidence.claims ?? []).some((evidenceClaim) =>
				taskClaims.some((taskClaim) => sameClaim(evidenceClaim, taskClaim)),
			),
		);
		const evidenceIds = new Set([
			...(task.progress?.evidenceRefs ?? []),
			...task.evidence.map((evidence) => evidence.id),
			...claimEvidence.map((evidence) => evidence.id),
			...handoffs.flatMap((handoff) => handoff.evidenceIds),
		]);
		const relevantEvidence = allEvidence
			.filter((evidence) => evidenceIds.has(evidence.id))
			.slice(-AGENT_TASK_CONTEXT_EVIDENCE_MAX_ITEMS);
		return {
			rootObjective: root.objective,
			...(this.state.inheritedContext
				? { rootContext: clone(this.state.inheritedContext) }
				: this.state.rootContext
					? { rootContext: clone(this.state.rootContext) }
					: {}),
			...(this.state.rootContext ? { rootContextDescriptor: rootContextDescriptor(this.state.rootContext) } : {}),
			taskId: task.id,
			...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
			lineage: this.lineage(task.id),
			scope: task.scope,
			exclusiveClaims: clone(task.exclusiveClaims),
			sharedClaims: clone(task.sharedClaims),
			exclusions: clone(task.exclusions),
			questions: [...task.questions],
			invariants: [...task.invariants],
			knownDecisions: [...task.knownDecisions],
			dependencies: [...task.dependencies],
			evidenceRefs: [...evidenceIds],
			...(task.plan ? { plan: clone(task.plan) } : {}),
			...(currentAttempt(task) ? { currentAttempt: clone(currentAttempt(task)!) } : {}),
			relevantHandoffs: clone(handoffs),
			relevantEvidence: clone(relevantEvidence),
			...(sharedBudget ? { sharedBudget } : {}),
			unresolvedQuestions: [...(task.result?.unresolvedQuestions ?? [])],
			verificationExpectations: [...task.verificationExpectations],
			...(task.resultSchema ? { resultSchema: clone(task.resultSchema) } : {}),
			version: task.version,
		};
	}

	getRootContext(): Record<string, unknown> | undefined {
		return this.state.rootContext ? clone(this.state.rootContext) : undefined;
	}

	getPendingResumeRequests(): AgentTaskResumeDispatch[] {
		return this.state.tasks.flatMap((task) => {
			const request = task.resumeRequest;
			if (task.status !== "pending" || request?.status !== "pending") return [];
			if (request.reason === "descendants_terminal" && this.hasActiveDescendants(task.id)) return [];
			return [
				{
					...clone(request),
					ownerAgentId: task.ownerAgentId,
					gaps: clone(task.gaps.filter((gap) => request.gapIds.includes(gap.id))),
					supervisionAlerts:
						request.reason === "supervision_required"
							? clone(
									this.getSupervisionAlerts().filter(
										(alert) => alert.kind === "blocked_gap" && this.isDescendant(task.id, alert.taskId),
									),
								)
							: [],
					context: this.contextEnvelope(task.id),
				},
			];
		});
	}

	deferUntilDescendantsComplete(
		taskId: string,
		callerAgentId: string,
	): { state: "ready"; task: AgentTask } | { state: "waiting"; task: AgentTask; request: AgentTaskResumeRequest } {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "wait for descendants of");
		if (task.resumeRequest?.status === "pending") {
			if (task.resumeRequest.reason !== "descendants_terminal") {
				throw new AgentTaskGraphError(`task ${taskId} is already waiting for a different resume condition`);
			}
			if (!this.hasActiveDescendants(task.id)) {
				return {
					state: "ready",
					task: this.markResumeAdmitted(task.id, task.resumeRequest.id, callerAgentId),
				};
			}
			return { state: "waiting", task: clone(task), request: clone(task.resumeRequest) };
		}
		if (!this.hasActiveDescendants(task.id)) return { state: "ready", task: clone(task) };
		const request: AgentTaskResumeRequest = {
			id: `resume-descendants-${randomUUID()}`,
			taskId: task.id,
			ownerAgentId: task.ownerAgentId,
			reason: "descendants_terminal",
			gapIds: [],
			gapCount: task.gaps.length,
			status: "pending",
			requestedAt: new Date().toISOString(),
		};
		const next = touchTask({ ...task, status: "pending", resumeRequest: request });
		this.commit("task.waiting_for_descendants", callerAgentId, [next]);
		return { state: "waiting", task: clone(next), request: clone(request) };
	}

	reserveDelegation(input: {
		parentTaskId: string;
		callerAgentId: string;
		childAgentId: string;
		task: AgentTaskDelegationInput;
	}): AgentTask {
		const parent = this.findTask(input.parentTaskId);
		this.assertOwner(parent, input.callerAgentId);
		this.assertActive(parent, "delegate from");
		this.assertSharedBudgetAvailable();
		if (this.policy.requireDelegatedTaskPlan && parent.parentTaskId && !parent.plan) {
			throw new AgentTaskGraphError(`task ${parent.id} must record a leaf-or-coordinator plan before delegating`);
		}
		if (parent.plan?.mode === "leaf") {
			throw new AgentTaskGraphError(
				`task ${parent.id} planned as a leaf and must revise its plan before delegating`,
			);
		}
		const normalized = normalizeDelegationInput(input.task);
		if (this.policy.requireDelegationContractKey && !normalized.contractKey) {
			throw new AgentTaskGraphError("delegated task must include a stable contractKey");
		}
		if (!isMeaningfullyNarrower(parent, normalized)) {
			throw new AgentTaskGraphError("delegated task must be meaningfully narrower than its parent task");
		}
		const exclusiveClaims = normalized.exclusiveClaims ?? [];
		if (this.policy.requireExclusiveClaims && exclusiveClaims.length === 0) {
			throw new AgentTaskGraphError("delegated task must transfer at least one exclusive claim");
		}
		for (const claim of exclusiveClaims) {
			if (!parent.exclusiveClaims.some((candidate) => sameClaim(candidate, claim))) {
				throw new AgentTaskGraphError(`parent task does not own exclusive claim ${claimKey(claim)}`);
			}
		}
		for (const claim of normalized.sharedClaims ?? []) {
			if (
				!parent.exclusiveClaims.some((candidate) => sameClaim(candidate, claim)) &&
				!parent.sharedClaims.some((candidate) => sameClaim(candidate, claim))
			) {
				throw new AgentTaskGraphError(`parent task cannot grant shared claim ${claimKey(claim)}`);
			}
		}
		for (const claim of exclusiveClaims) {
			const conflicting = this.state.tasks.find(
				(candidate) =>
					candidate.id !== parent.id &&
					ACTIVE_TASK_STATUSES.has(candidate.status) &&
					candidate.exclusiveClaims.some((owned) => sameClaim(owned, claim)),
			);
			if (conflicting) {
				throw new AgentTaskGraphError(
					`exclusive claim ${claimKey(claim)} is already owned by task ${conflicting.id}`,
				);
			}
		}
		const childId = normalizeIdentifier(normalized.id ?? `task-${randomUUID()}`, "task.id");
		if (this.state.tasks.some((task) => task.id === childId)) {
			throw new AgentTaskGraphError(`task id already exists: ${childId}`);
		}
		const signature = delegationSignature(parent.id, normalized);
		const duplicate = this.state.tasks.find(
			(task) =>
				task.parentTaskId === parent.id &&
				ACTIVE_TASK_STATUSES.has(task.status) &&
				taskSignature(task) === signature,
		);
		if (duplicate)
			throw new AgentTaskGraphError(`substantially identical delegated task already exists: ${duplicate.id}`);
		const historicalDuplicate = this.state.tasks
			.filter((task) => !ACTIVE_TASK_STATUSES.has(task.status) && historicallyOverlaps(task, normalized))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
		if (historicalDuplicate && normalized.predecessorTaskId !== historicalDuplicate.id) {
			throw new AgentTaskGraphError(
				`exclusive claim coverage was already attempted by ${historicalDuplicate.id}; link the latest attempt as predecessorTaskId and name a repeatReason`,
			);
		}
		if (normalized.predecessorTaskId) {
			const predecessor = this.findTask(normalized.predecessorTaskId);
			if (ACTIVE_TASK_STATUSES.has(predecessor.status)) {
				throw new AgentTaskGraphError("predecessorTaskId must identify a terminal task in this graph");
			}
			if (!normalized.repeatReason) {
				throw new AgentTaskGraphError("a successor delegation must include repeatReason");
			}
			const handoff = lastHandoff(predecessor);
			if (!handoff) throw new AgentTaskGraphError(`predecessor task ${predecessor.id} has no durable handoff`);
			for (const claim of exclusiveClaims) {
				if (!handoff.remainingClaims.some((remaining) => sameClaim(remaining, claim))) {
					throw new AgentTaskGraphError(
						`successor claim ${claimKey(claim)} was not left remaining by ${predecessor.id}`,
					);
				}
			}
		}
		this.policy.validateDelegation?.({
			parent: clone(parent),
			child: clone(normalized),
			snapshot: clone(this.state),
		});

		const now = new Date().toISOString();
		const child: AgentTask = {
			id: childId,
			parentTaskId: parent.id,
			createdByAgentId: input.callerAgentId,
			ownerAgentId: normalizeIdentifier(input.childAgentId, "childAgentId"),
			objective: normalized.objective,
			scope: normalized.scope,
			exclusiveClaims: clone(exclusiveClaims),
			sharedClaims: clone(normalized.sharedClaims ?? []),
			exclusions: clone(normalized.exclusions ?? []),
			questions: [...normalized.questions],
			invariants: [...normalized.invariants],
			knownDecisions: [...normalized.knownDecisions],
			dependencies: [...normalized.dependencies],
			verificationExpectations: [...normalized.verificationExpectations],
			...(normalized.resultSchema ? { resultSchema: clone(normalized.resultSchema) } : {}),
			delegationReason: normalized.delegationReason,
			...(normalized.contractKey ? { contractKey: normalized.contractKey } : {}),
			...(normalized.predecessorTaskId ? { predecessorTaskId: normalized.predecessorTaskId } : {}),
			...(normalized.repeatReason ? { repeatReason: normalized.repeatReason } : {}),
			evidence: [],
			attempts: [createAttempt(input.childAgentId, "pending")],
			status: "pending",
			delegationState: "retained",
			gaps: [],
			usage: emptyUsage(),
			usageAttributions: [],
			childAgentId: input.childAgentId,
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		const nextParent = touchTask({
			...parent,
			exclusiveClaims: parent.exclusiveClaims.filter(
				(claim) => !exclusiveClaims.some((transferred) => sameClaim(claim, transferred)),
			),
		});
		nextParent.delegationState = nextParent.exclusiveClaims.length === 0 ? "fully_delegated" : "partially_delegated";
		this.commit("task.delegated", input.callerAgentId, [nextParent, child]);
		return clone(child);
	}

	startTask(taskId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		if (task.status !== "pending" && task.status !== "starting") {
			throw new AgentTaskGraphError(`task ${taskId} cannot start from status ${task.status}`);
		}
		const next = touchTask({
			...task,
			status: "running",
			attempts: updateCurrentAttempt(task, callerAgentId, (attempt) => ({
				...attempt,
				status: "running",
				startedAt: attempt.startedAt ?? new Date().toISOString(),
			})),
			...(task.resumeRequest?.status === "pending"
				? {
						resumeRequest: {
							...task.resumeRequest,
							status: "admitted" as const,
							admittedAt: new Date().toISOString(),
						},
					}
				: {}),
		});
		this.commit("task.started", callerAgentId, [next]);
		return clone(next);
	}

	recordPlan(taskId: string, callerAgentId: string, plan: Omit<AgentTaskPlan, "recordedAt">): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "plan");
		if (task.evidence.length > 0 || this.childrenOf(task.id).length > 0) {
			throw new AgentTaskGraphError(`task ${task.id} must record its plan before exploration or delegation`);
		}
		const normalized = normalizeTaskPlan(plan);
		const next = touchTask({ ...task, plan: { ...normalized, recordedAt: new Date().toISOString() } });
		this.commit("task.planned", callerAgentId, [next]);
		return clone(next);
	}

	assertCanExplore(taskId: string, callerAgentId: string): void {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "explore");
		if (this.policy.requireDelegatedTaskPlan && task.parentTaskId && !task.plan) {
			throw new AgentTaskGraphError(`task ${task.id} must record a leaf-or-coordinator plan before exploration`);
		}
		this.assertSharedBudgetAvailable();
	}

	assertEvidenceScopeAvailable(taskId: string, callerAgentId: string, claims: AgentTaskResourceClaim[]): void {
		this.assertCanExplore(taskId, callerAgentId);
		const task = this.findTask(taskId);
		const normalizedClaims = normalizeClaims(claims, "evidence claims");
		const transferredClaims = this.state.tasks
			.filter((candidate) => candidate.id !== task.id && this.isDescendant(task.id, candidate.id))
			.filter((candidate) => ACTIVE_TASK_STATUSES.has(candidate.status))
			.flatMap((candidate) => candidate.exclusiveClaims);
		const repeated = normalizedClaims.find((claim) =>
			transferredClaims.some((transferred) => sameClaim(transferred, claim)),
		);
		if (repeated) {
			throw new AgentTaskGraphError(
				`task ${task.id} cannot inspect claim ${claimKey(repeated)} while an active descendant owns it`,
			);
		}
		const unauthorized = normalizedClaims.find(
			(claim) =>
				!task.exclusiveClaims.some((owned) => sameClaim(owned, claim)) &&
				!task.sharedClaims.some((shared) => sameClaim(shared, claim)),
		);
		if (unauthorized) {
			throw new AgentTaskGraphError(`task ${task.id} is not authorized to inspect claim ${claimKey(unauthorized)}`);
		}
	}

	recordEvidence(
		taskId: string,
		callerAgentId: string,
		rawEvidence: AgentTaskEvidenceInput,
	): { evidence: AgentTaskEvidence; novel: boolean; task: AgentTask } {
		const task = this.findTask(taskId);
		const evidenceInput = normalizeTaskEvidenceInput(rawEvidence);
		this.assertEvidenceScopeAvailable(taskId, callerAgentId, evidenceInput.claims ?? []);
		const identity = evidenceIdentity(evidenceInput);
		const existing = this.state.tasks
			.flatMap((candidate) => candidate.evidence)
			.find((evidence) => evidenceIdentity(evidence) === identity);
		const evidence = existing ?? {
			...evidenceInput,
			id: `evidence-${identity}`,
			producedByTaskId: task.id,
			producedByAttemptId: requireCurrentAttempt(task).id,
			createdAt: new Date().toISOString(),
		};
		const evidenceRefs = mergeStrings(task.progress?.evidenceRefs ?? [], [evidence.id]);
		if (existing && evidenceRefs.length === (task.progress?.evidenceRefs.length ?? 0)) {
			return { evidence: clone(evidence), novel: false, task: clone(task) };
		}
		const now = new Date().toISOString();
		const next = touchTask({
			...task,
			evidence: existing ? task.evidence : [...task.evidence, evidence],
			progress: {
				summary: task.progress?.summary ?? `Recorded ${evidence.kind} evidence`,
				evidenceRefs,
				completedQuestions: task.progress?.completedQuestions ?? [],
				updatedAt: now,
			},
		});
		this.commit(existing ? "task.evidence_reused" : "task.evidence_recorded", callerAgentId, [next]);
		return { evidence: clone(evidence), novel: !existing, task: clone(next) };
	}

	recordHandoff(taskId: string, callerAgentId: string, rawHandoff: AgentTaskHandoffInput): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "record a handoff for");
		const handoff = normalizeTaskHandoff(rawHandoff, task);
		const next = touchTask({
			...task,
			attempts: updateCurrentAttempt(task, callerAgentId, (attempt) => ({ ...attempt, handoff })),
		});
		this.commit("task.handoff_recorded", callerAgentId, [next]);
		return clone(next);
	}

	markResumeAdmitted(taskId: string, requestId: string, callerAgentId: string): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		const request = task.resumeRequest;
		if (!request || request.id !== requestId) {
			throw new AgentTaskGraphError(`unknown resume request ${requestId} for task ${taskId}`);
		}
		if (request.status === "admitted") return clone(task);
		if (task.status !== "pending") {
			throw new AgentTaskGraphError(`task ${taskId} cannot admit a resume from status ${task.status}`);
		}
		const next = touchTask({
			...task,
			status: "running",
			attempts: updateCurrentAttempt(task, callerAgentId, (attempt) => ({
				...attempt,
				status: "running",
				startedAt: attempt.startedAt ?? new Date().toISOString(),
			})),
			resumeRequest: {
				...request,
				status: "admitted",
				admittedAt: new Date().toISOString(),
			},
		});
		this.commit("task.resume_admitted", callerAgentId, [next]);
		return clone(next);
	}

	updateProgress(
		taskId: string,
		callerAgentId: string,
		progress: { summary: string; evidenceRefs?: string[]; completedQuestions?: string[] },
	): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "update");
		const now = new Date().toISOString();
		const next = touchTask({
			...task,
			status: task.status === "pending" || task.status === "starting" ? "running" : task.status,
			progress: {
				summary: normalizeText(progress.summary, "progress.summary"),
				evidenceRefs:
					progress.evidenceRefs === undefined
						? (task.progress?.evidenceRefs ?? [])
						: normalizeStringList(progress.evidenceRefs, "progress.evidenceRefs"),
				completedQuestions:
					progress.completedQuestions === undefined
						? (task.progress?.completedQuestions ?? [])
						: normalizeStringList(progress.completedQuestions, "progress.completedQuestions"),
				updatedAt: now,
			},
		});
		this.commit("task.progress", callerAgentId, [next]);
		return clone(next);
	}

	reportGap(
		taskId: string,
		callerAgentId: string,
		input: {
			kind: AgentTaskGap["kind"];
			description: string;
			neededInformation?: string;
			evidenceRefs?: string[];
		},
	): AgentTaskGap {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "report a gap for");
		if (!["coverage", "context", "dependency", "other"].includes(input.kind)) {
			throw new AgentTaskGraphError(`unsupported gap kind: ${input.kind}`);
		}
		const now = new Date().toISOString();
		const gap: AgentTaskGap = {
			id: `gap-${randomUUID()}`,
			kind: input.kind,
			description: normalizeText(input.description, "gap.description"),
			...(input.neededInformation
				? { neededInformation: normalizeText(input.neededInformation, "gap.neededInformation") }
				: {}),
			status: "open",
			reportedByAgentId: callerAgentId,
			evidenceRefs: normalizeStringList(input.evidenceRefs ?? [], "gap.evidenceRefs"),
			createdAt: now,
			updatedAt: now,
		};
		const next = touchTask({ ...task, status: "blocked", gaps: [...task.gaps, gap] });
		const supervisor = this.findAvailableSupervisor(task);
		const nextSupervisor = supervisor ? this.requestSupervision(supervisor, now) : undefined;
		this.commit("task.gap_reported", callerAgentId, nextSupervisor ? [next, nextSupervisor] : [next]);
		return clone(gap);
	}

	resolveGap(
		taskId: string,
		gapId: string,
		callerAgentId: string,
		input: { status: "resolved" | "declined"; resolution: string; evidenceRefs?: string[] },
	): AgentTaskGap {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		const index = task.gaps.findIndex((gap) => gap.id === gapId);
		if (index < 0) throw new AgentTaskGraphError(`unknown gap ${gapId} for task ${taskId}`);
		const gap = task.gaps[index]!;
		if (gap.status !== "open") throw new AgentTaskGraphError(`gap ${gapId} is already ${gap.status}`);
		const nextGap: AgentTaskGap = {
			...gap,
			status: input.status,
			resolution: normalizeText(input.resolution, "gap.resolution"),
			evidenceRefs: normalizeStringList(input.evidenceRefs ?? gap.evidenceRefs, "gap.evidenceRefs"),
			updatedAt: new Date().toISOString(),
		};
		const gaps = [...task.gaps];
		gaps[index] = nextGap;
		const becomesRunnable = task.status === "blocked" && gaps.every((candidate) => candidate.status !== "open");
		const requestedAt = new Date().toISOString();
		const cycleStart = task.resumeRequest?.gapCount ?? 0;
		const next = touchTask({
			...task,
			status: becomesRunnable ? "pending" : task.status,
			gaps,
			...(becomesRunnable
				? {
						resumeRequest: {
							id: `resume-${nextGap.id}`,
							taskId: task.id,
							ownerAgentId: task.ownerAgentId,
							reason: "gap_resolution" as const,
							gapIds: gaps.slice(cycleStart).map((candidate) => candidate.id),
							gapCount: gaps.length,
							status: "pending" as const,
							requestedAt,
						},
					}
				: {}),
		});
		this.commit("task.gap_resolved", callerAgentId, [next]);
		return clone(nextGap);
	}

	completeTask(taskId: string, callerAgentId: string, rawResult: AgentTaskResult): AgentTask {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "complete");
		const activeChildren = this.childrenOf(task.id).filter((child) => ACTIVE_TASK_STATUSES.has(child.status));
		if (activeChildren.length > 0) {
			throw new AgentTaskGraphError(
				`task ${taskId} still has active child tasks: ${activeChildren.map((child) => child.id).join(", ")}`,
			);
		}
		const result = normalizeTaskResult(rawResult);
		if (task.gaps.some((gap) => gap.status === "open")) {
			throw new AgentTaskGraphError(`task ${taskId} still has open gaps`);
		}
		try {
			this.policy.validateCompletion?.({ task: clone(task), result: clone(result), snapshot: clone(this.state) });
		} catch (error) {
			const rejectedHandoff = handoffFromRejectedResult(task, result);
			const next = touchTask({
				...task,
				attempts: updateCurrentAttempt(task, callerAgentId, (attempt) => ({
					...attempt,
					handoff: rejectedHandoff,
				})),
			});
			this.commit("task.handoff_recorded", callerAgentId, [next]);
			throw error;
		}
		const handoff = handoffFromResult(task, result);
		const next = touchTask({
			...task,
			status: "completed",
			result,
			attempts: finishCurrentAttempt(task, callerAgentId, "completed", handoff),
		});
		this.commit("task.completed", callerAgentId, [next]);
		return clone(next);
	}

	completeTaskFromRuntime(taskId: string, callerAgentId: string, summary: string): AgentTask {
		const task = this.findTask(taskId);
		if (task.status === "completed") return clone(task);
		return this.completeTask(taskId, callerAgentId, this.runtimeCompletionDraft(taskId, summary));
	}

	runtimeCompletionDraft(taskId: string, summary: string): AgentTaskResult {
		const task = this.findTask(taskId);
		return {
			summary: boundedRuntimeText(summary, "Task completed without a textual result."),
			verification: [],
			candidateFindings: [],
			unresolvedQuestions: [],
			coverageGaps: [],
			evidenceRefs: task.progress?.evidenceRefs ?? [],
		};
	}

	canAutoCompleteTask(taskId: string): boolean {
		const task = this.findTask(taskId);
		return (
			ACTIVE_TASK_STATUSES.has(task.status) &&
			task.delegationState === "retained" &&
			!task.gaps.some((gap) => gap.status === "open") &&
			!this.childrenOf(task.id).some((child) => ACTIVE_TASK_STATUSES.has(child.status))
		);
	}

	delegatedTaskConvergence(taskId: string):
		| {
				maxToolCallsWithoutEvidence: number;
				maxToolCallsAfterSteer: number;
				maxExplorationToolCalls?: number;
		  }
		| undefined {
		this.findTask(taskId);
		const policy = this.policy.delegatedTaskConvergence;
		if (!policy) return undefined;
		return { ...policy };
	}

	recordDelegatedTaskConvergenceTurn(
		taskId: string,
		callerAgentId: string,
		toolCalls: number,
	): AgentTaskConvergenceUpdate | undefined {
		const task = this.findTask(taskId);
		this.assertOwner(task, callerAgentId);
		this.assertActive(task, "record convergence for");
		const policy = this.policy.delegatedTaskConvergence;
		if (!policy) return undefined;
		const turnToolCalls = normalizeNonNegativeInteger(toolCalls, "convergence toolCalls");
		const current = task.convergence ?? emptyConvergenceState();
		const seenEvidenceRefs = new Set(current.seenEvidenceRefs);
		let discoveredEvidence = false;
		for (const evidenceRef of task.evidence.map((evidence) => evidence.id)) {
			if (seenEvidenceRefs.has(evidenceRef)) continue;
			seenEvidenceRefs.add(evidenceRef);
			discoveredEvidence = true;
		}
		let enteredFinalizing = false;
		const nextState: AgentTaskConvergenceState = {
			...current,
			seenEvidenceRefs: [...seenEvidenceRefs],
		};
		if (current.phase === "exploring") {
			nextState.explorationToolCalls += turnToolCalls;
			nextState.toolCallsWithoutEvidence =
				(discoveredEvidence ? 0 : current.toolCallsWithoutEvidence) + turnToolCalls;
			if (
				nextState.toolCallsWithoutEvidence >= policy.maxToolCallsWithoutEvidence ||
				this.getSharedBudget()?.exhausted === true ||
				(policy.maxExplorationToolCalls !== undefined &&
					nextState.explorationToolCalls >= policy.maxExplorationToolCalls)
			) {
				nextState.phase = "finalizing";
				enteredFinalizing = true;
			}
		} else {
			nextState.finalizingToolCalls += turnToolCalls;
		}
		const exhausted =
			nextState.phase === "finalizing" && nextState.finalizingToolCalls >= policy.maxToolCallsAfterSteer;
		const next = touchTask({ ...task, convergence: nextState });
		this.commit("task.convergence_recorded", callerAgentId, [next]);
		return {
			state: clone(nextState),
			enteredFinalizing,
			exhausted,
			remainingFinalizationToolCalls: Math.max(0, policy.maxToolCallsAfterSteer - nextState.finalizingToolCalls),
		};
	}

	allowsDelegatedTaskCompletionCorrection(taskId: string): boolean {
		this.findTask(taskId);
		return this.policy.delegatedTaskCompletionCorrection === true;
	}

	executionProfile(): "inspection_only" | undefined {
		return this.policy.executionProfile;
	}

	interruptTask(taskId: string, callerAgentId: string, reason: string, handoff?: AgentTaskHandoffInput): AgentTask {
		const task = this.findTask(taskId);
		if (task.status === "completed" || task.status === "cancelled" || task.status === "interrupted")
			return clone(task);
		if (callerAgentId !== task.ownerAgentId) this.assertCanSupervise(task, callerAgentId);
		const changed = this.cancelSubtree(task, "interrupted", reason, handoff);
		this.commit("task.interrupted", callerAgentId, changed);
		return this.getTask(taskId);
	}

	cancelTask(taskId: string, callerAgentId: string, reason: string, handoff?: AgentTaskHandoffInput): AgentTask {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		const changed = this.cancelSubtree(task, "cancelled", reason, handoff);
		this.commit("task.cancelled", callerAgentId, changed);
		return this.getTask(taskId);
	}

	reassignTask(
		taskId: string,
		callerAgentId: string,
		newOwnerAgentId: string,
		handoff?: AgentTaskHandoffInput,
	): AgentTask {
		const task = this.findTask(taskId);
		this.assertCanSupervise(task, callerAgentId);
		this.assertActive(task, "reassign");
		const ownerAgentId = normalizeIdentifier(newOwnerAgentId, "newOwnerAgentId");
		const previousAttempt = requireCurrentAttempt(task);
		const durableHandoff = normalizeTaskHandoff(
			handoff ?? fallbackHandoff(task, "Replaced by supervising agent"),
			task,
		);
		const next = touchTask({
			...task,
			ownerAgentId,
			childAgentId: ownerAgentId,
			status: task.status,
			attempts: [
				...finishCurrentAttempt(task, task.ownerAgentId, "replaced", durableHandoff),
				createAttempt(
					ownerAgentId,
					task.status === "pending" || task.status === "starting" ? "pending" : "running",
					previousAttempt.id,
				),
			],
			...(task.resumeRequest ? { resumeRequest: { ...task.resumeRequest, ownerAgentId } } : {}),
		});
		this.commit("task.reassigned", callerAgentId, [next]);
		return clone(next);
	}

	recordUsage(
		taskId: string,
		usage: Partial<AgentTaskUsage>,
		actorAgentId: string,
		attribution?: Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model">,
	): AgentTask {
		const task = this.findTask(taskId);
		const delta: AgentTaskUsage = {
			input: normalizeUsageNumber(usage.input),
			output: normalizeUsageNumber(usage.output),
			cacheRead: normalizeUsageNumber(usage.cacheRead),
			cacheWrite: normalizeUsageNumber(usage.cacheWrite),
			cost: normalizeUsageNumber(usage.cost),
		};
		const normalizedAttribution = normalizeUsageAttribution(attribution);
		const next = addUsageDelta(task, delta, new Date().toISOString(), task.version + 1, normalizedAttribution);
		this.commitUsage(actorAgentId, next, delta, normalizedAttribution);
		return clone(next);
	}

	getTotalUsage(): AgentTaskUsage {
		return this.state.tasks.reduce<AgentTaskUsage>(
			(total, task) => ({
				input: total.input + task.usage.input,
				output: total.output + task.usage.output,
				cacheRead: total.cacheRead + task.usage.cacheRead,
				cacheWrite: total.cacheWrite + task.usage.cacheWrite,
				cost: total.cost + task.usage.cost,
			}),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
	}

	getSharedBudget(): AgentTaskSharedBudget | undefined {
		const maxTotalTokens = this.policy.maxTotalTokens;
		if (maxTotalTokens === undefined) return undefined;
		const usage = this.getTotalUsage();
		const usedTokens = usage.input + usage.output;
		return {
			maxTotalTokens,
			usedTokens,
			remainingTokens: Math.max(0, maxTotalTokens - usedTokens),
			exhausted: usedTokens >= maxTotalTokens,
		};
	}

	getUsageAttributions(): Array<AgentTaskUsageAttribution & { taskId: string }> {
		return this.state.tasks.flatMap((task) =>
			(task.usageAttributions ?? []).map((attribution) => ({
				...clone(attribution),
				taskId: task.id,
			})),
		);
	}

	assertTreeComplete(): void {
		const unfinished = this.state.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
		if (unfinished.length > 0) {
			throw new AgentTaskGraphError(
				`task graph still has unfinished tasks: ${unfinished.map((task) => task.id).join(", ")}`,
			);
		}
	}

	assertDelegatedTasksComplete(): void {
		const unfinished = this.state.tasks.filter(
			(task) => task.id !== this.state.rootTaskId && ACTIVE_TASK_STATUSES.has(task.status),
		);
		if (unfinished.length > 0) {
			throw new AgentTaskGraphError(
				`task graph still has unfinished delegated tasks: ${unfinished.map((task) => task.id).join(", ")}`,
			);
		}
	}

	hasActiveDescendants(taskId: string): boolean {
		this.findTask(taskId);
		const pending = [...this.childrenOf(taskId)];
		while (pending.length > 0) {
			const task = pending.pop()!;
			if (ACTIVE_TASK_STATUSES.has(task.status)) return true;
			pending.push(...this.childrenOf(task.id));
		}
		return false;
	}

	async waitForDescendantsComplete(taskId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		this.findTask(taskId);
		while (true) {
			if (this.fatalError) {
				throw new AgentTaskGraphError(`task graph durability failed: ${this.fatalError.message}`, {
					cause: this.fatalError,
				});
			}
			if (options.signal?.aborted) throw new AgentTaskGraphError("task descendant wait cancelled");
			if (!this.hasActiveDescendants(taskId)) return;
			await new Promise<void>((resolve, reject) => {
				const onChange = () => {
					cleanup();
					resolve();
				};
				const onAbort = () => {
					cleanup();
					reject(new AgentTaskGraphError("task descendant wait cancelled"));
				};
				const cleanup = () => {
					this.changeWaiters.delete(onChange);
					options.signal?.removeEventListener("abort", onAbort);
				};
				this.changeWaiters.add(onChange);
				options.signal?.addEventListener("abort", onAbort, { once: true });
				// Close the predicate/subscription race without polling.
				if (!this.hasActiveDescendants(taskId)) onChange();
				else if (options.signal?.aborted) onAbort();
			});
		}
	}

	private loadOrCreate(rootInput: AgentTaskRootInput): AgentTaskGraphSnapshot {
		if (existsSync(this.snapshotPath)) {
			const loaded = parseSnapshot(readFileSync(this.snapshotPath, "utf8"));
			return this.replayEvents(loaded);
		}
		const root = normalizeRootInput(rootInput);
		const now = new Date().toISOString();
		const task: AgentTask = {
			id: root.id ?? "task-root",
			createdByAgentId: root.ownerAgentId,
			ownerAgentId: root.ownerAgentId,
			objective: root.objective,
			scope: root.scope ?? root.objective,
			exclusiveClaims: clone(root.exclusiveClaims ?? []),
			sharedClaims: clone(root.sharedClaims ?? []),
			exclusions: clone(root.exclusions ?? []),
			questions: [...(root.questions ?? [])],
			invariants: [...(root.invariants ?? [])],
			knownDecisions: [...(root.knownDecisions ?? [])],
			dependencies: [...(root.dependencies ?? [])],
			verificationExpectations: [...(root.verificationExpectations ?? [])],
			...(root.resultSchema ? { resultSchema: clone(root.resultSchema) } : {}),
			status: "running",
			delegationState: "retained",
			evidence: [],
			attempts: [createAttempt(root.ownerAgentId, "running")],
			gaps: [],
			usage: emptyUsage(),
			usageAttributions: [],
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		const state: AgentTaskGraphSnapshot = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: `graph-${randomUUID()}`,
			rootTaskId: task.id,
			rootAgentId: root.ownerAgentId,
			...(root.rootContext ? { rootContext: clone(root.rootContext) } : {}),
			...(root.inheritedContext ? { inheritedContext: clone(root.inheritedContext) } : {}),
			version: 1,
			tasks: [task],
		};
		this.persistInitial(state, root.ownerAgentId);
		return state;
	}

	private recover(rootAgentId: string): void {
		const root = this.findTask(this.state.rootTaskId);
		const rootAgentChanged = this.state.rootAgentId !== rootAgentId;
		const rootHasPendingResume = root.status === "pending" && root.resumeRequest?.status === "pending";
		const recoveredRootStatus = rootHasPendingResume ? "pending" : "running";
		const rootNeedsRecovery =
			root.ownerAgentId !== rootAgentId ||
			root.status !== recoveredRootStatus ||
			(root.resumeRequest !== undefined && root.resumeRequest.ownerAgentId !== rootAgentId);
		if (rootNeedsRecovery || rootAgentChanged) {
			this.commit(
				"graph.recovered",
				rootAgentId,
				rootNeedsRecovery
					? [
							touchTask({
								...root,
								ownerAgentId: rootAgentId,
								status: recoveredRootStatus,
								attempts: rebindActiveAttempt(root, rootAgentId, "Root session recovered"),
								...(root.resumeRequest
									? { resumeRequest: { ...root.resumeRequest, ownerAgentId: rootAgentId } }
									: {}),
							}),
						]
					: [],
				rootAgentChanged ? { rootAgentId } : undefined,
			);
		}
		const preservedTaskIds = new Set<string>();
		for (const task of this.state.tasks) {
			if (task.status !== "pending" || task.resumeRequest?.status !== "pending") continue;
			let current: AgentTask | undefined = task;
			while (current) {
				preservedTaskIds.add(current.id);
				current = current.parentTaskId
					? this.state.tasks.find((candidate) => candidate.id === current?.parentTaskId)
					: undefined;
			}
		}
		const activeTaskIds = new Set(
			this.state.tasks
				.filter(
					(task) =>
						task.id !== this.state.rootTaskId &&
						ACTIVE_TASK_STATUSES.has(task.status) &&
						!preservedTaskIds.has(task.id),
				)
				.map((task) => task.id),
		);
		const recoveryRoots = this.state.tasks.filter(
			(task) => activeTaskIds.has(task.id) && (!task.parentTaskId || !activeTaskIds.has(task.parentTaskId)),
		);
		// Commit each recovery root independently so sibling claim reclamation composes
		// against the state produced by the previous interruption.
		for (const task of recoveryRoots) {
			const current = this.findTask(task.id);
			if (!ACTIVE_TASK_STATUSES.has(current.status)) continue;
			this.commit(
				"task.recovered_as_interrupted",
				rootAgentId,
				this.cancelSubtree(current, "interrupted", "Runtime restarted before task completion"),
			);
		}
	}

	private replayEvents(snapshot: AgentTaskGraphSnapshot): AgentTaskGraphSnapshot {
		if (!existsSync(this.eventsPath)) return snapshot;
		let state = snapshot;
		const lines = readFileSync(this.eventsPath, "utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!.trim();
			if (!line) continue;
			let event: AgentTaskGraphEvent;
			try {
				event = JSON.parse(line) as AgentTaskGraphEvent;
			} catch (error) {
				if (index === lines.length - 1) break;
				throw new AgentTaskGraphError(`invalid task graph event at line ${index + 1}: ${String(error)}`, {
					cause: asError(error),
				});
			}
			if (event.graphId !== state.graphId || event.graphVersion <= state.version) continue;
			const tasks = new Map(state.tasks.map((task) => [task.id, task]));
			for (const task of event.tasks) tasks.set(task.id, normalizeUsageAttributions(task));
			if (event.usageDelta) {
				const task = tasks.get(event.usageDelta.taskId);
				if (!task) throw new AgentTaskGraphError(`usage event references unknown task: ${event.usageDelta.taskId}`);
				const attribution = normalizeUsageAttribution(event.usageDelta.attribution);
				tasks.set(
					task.id,
					addUsageDelta(
						task,
						event.usageDelta.usage,
						event.usageDelta.updatedAt,
						event.usageDelta.taskVersion,
						attribution,
					),
				);
			}
			state = {
				...state,
				version: event.graphVersion,
				...(event.rootAgentId ? { rootAgentId: event.rootAgentId } : {}),
				tasks: [...tasks.values()],
			};
			this.eventsSinceSnapshot += 1;
			this.bytesSinceSnapshot += Buffer.byteLength(line, "utf8") + 1;
		}
		return state;
	}

	private persistInitial(state: AgentTaskGraphSnapshot, actorAgentId: string): void {
		const event: AgentTaskGraphEvent = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: state.graphId,
			graphVersion: state.version,
			type: "graph.created",
			actorAgentId,
			taskIds: [state.rootTaskId],
			tasks: clone(state.tasks),
			at: new Date().toISOString(),
		};
		appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		this.writeSnapshot(state);
	}

	private commit(
		type: string,
		actorAgentId: string,
		changedTasks: AgentTask[],
		graphPatch?: { rootAgentId?: string },
	): void {
		if (changedTasks.length === 0 && !graphPatch?.rootAgentId) return;
		this.assertWritable();
		const version = this.state.version + 1;
		const tasks = new Map(this.state.tasks.map((task) => [task.id, task]));
		for (const task of changedTasks) tasks.set(task.id, task);
		const next: AgentTaskGraphSnapshot = {
			...this.state,
			version,
			...(graphPatch?.rootAgentId ? { rootAgentId: graphPatch.rootAgentId } : {}),
			tasks: [...tasks.values()],
		};
		const event: AgentTaskGraphEvent = {
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: next.graphId,
			graphVersion: version,
			type,
			actorAgentId,
			taskIds: changedTasks.map((task) => task.id),
			tasks: clone(changedTasks),
			...(graphPatch?.rootAgentId ? { rootAgentId: graphPatch.rootAgentId } : {}),
			at: new Date().toISOString(),
		};
		this.appendEvent(event);
		this.state = next;
		this.compactSnapshot(false);
		this.notifyChangeWaiters();
	}

	private commitUsage(
		actorAgentId: string,
		nextTask: AgentTask,
		usage: AgentTaskUsage,
		attribution?: Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model">,
	): void {
		this.assertWritable();
		const version = this.state.version + 1;
		const tasks = new Map(this.state.tasks.map((task) => [task.id, task]));
		tasks.set(nextTask.id, nextTask);
		const next = { ...this.state, version, tasks: [...tasks.values()] };
		this.appendEvent({
			schemaVersion: AGENT_TASK_GRAPH_SCHEMA_VERSION,
			graphId: next.graphId,
			graphVersion: version,
			type: "task.usage",
			actorAgentId,
			taskIds: [nextTask.id],
			tasks: [],
			usageDelta: {
				taskId: nextTask.id,
				usage,
				...(attribution ? { attribution } : {}),
				taskVersion: nextTask.version,
				updatedAt: nextTask.updatedAt,
			},
			at: new Date().toISOString(),
		});
		this.state = next;
		this.compactSnapshot(false);
		this.notifyChangeWaiters();
	}

	private notifyChangeWaiters(): void {
		const waiters = [...this.changeWaiters];
		this.changeWaiters.clear();
		for (const waiter of waiters) waiter();
	}

	private appendEvent(event: AgentTaskGraphEvent): void {
		const encoded = `${JSON.stringify(event)}\n`;
		try {
			appendFileSync(this.eventsPath, encoded, { encoding: "utf8", mode: 0o600 });
			this.eventsSinceSnapshot += 1;
			this.bytesSinceSnapshot += Buffer.byteLength(encoded, "utf8");
		} catch (error) {
			this.fatalError = asError(error);
			this.notifyChangeWaiters();
			throw new AgentTaskGraphError(`task graph journal write failed: ${this.fatalError.message}`, {
				cause: this.fatalError,
			});
		}
	}

	private compactSnapshot(required: boolean): void {
		if (
			!required &&
			this.eventsSinceSnapshot < AGENT_TASK_SNAPSHOT_COMPACT_EVENT_THRESHOLD &&
			this.bytesSinceSnapshot < AGENT_TASK_SNAPSHOT_COMPACT_BYTE_THRESHOLD
		) {
			return;
		}
		try {
			this.writeSnapshot(this.state);
			writeFileSync(this.eventsPath, "", { encoding: "utf8", mode: 0o600 });
			chmodSync(this.eventsPath, 0o600);
			this.eventsSinceSnapshot = 0;
			this.bytesSinceSnapshot = 0;
			this.degradedError = undefined;
		} catch (error) {
			this.degradedError = asError(error);
			if (required) {
				throw new AgentTaskGraphError(`task graph checkpoint failed: ${this.degradedError.message}`, {
					cause: this.degradedError,
				});
			}
		}
	}

	private writeSnapshot(snapshot: AgentTaskGraphSnapshot): void {
		const temporaryPath = `${this.snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
		writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.snapshotPath);
		chmodSync(this.snapshotPath, 0o600);
	}

	private cancelSubtree(
		task: AgentTask,
		status: "cancelled" | "interrupted",
		reason: string,
		handoff?: AgentTaskHandoffInput,
	): AgentTask[] {
		const subtree = this.collectActiveSubtree(task);
		const changed = subtree.map((candidate) => {
			const durableHandoff = normalizeTaskHandoff(
				candidate.id === task.id && handoff ? handoff : fallbackHandoff(candidate, reason),
				candidate,
			);
			return touchTask({
				...candidate,
				status,
				result: {
					summary: boundedRuntimeText(reason, "Task cancelled without a reason."),
					verification: [],
					candidateFindings: [],
					unresolvedQuestions: [],
					coverageGaps: [],
					evidenceRefs: candidate.progress?.evidenceRefs ?? [],
				},
				attempts: finishCurrentAttempt(candidate, candidate.ownerAgentId, status, durableHandoff),
				reclaimedAt: new Date().toISOString(),
			});
		});
		if (task.parentTaskId) {
			const parent = this.findTask(task.parentTaskId);
			const reclaimed = subtree.reduce(
				(claims, candidate) => mergeClaims(claims, candidate.exclusiveClaims),
				parent.exclusiveClaims,
			);
			const nextParent = touchTask({
				...parent,
				exclusiveClaims: reclaimed,
				delegationState: "retained",
			});
			changed.push(nextParent);
		}
		return deduplicateTasks(changed);
	}

	private collectActiveSubtree(task: AgentTask): AgentTask[] {
		const tasks = [task];
		for (const child of this.childrenOf(task.id)) {
			if (ACTIVE_TASK_STATUSES.has(child.status)) tasks.push(...this.collectActiveSubtree(child));
		}
		return tasks;
	}

	private handoffsForTask(task: AgentTask): AgentTaskHandoff[] {
		const predecessor = task.predecessorTaskId ? this.findTask(task.predecessorTaskId) : undefined;
		const descendants = this.state.tasks.filter(
			(candidate) => candidate.id !== task.id && this.isDescendant(task.id, candidate.id),
		);
		return [
			...(predecessor?.attempts.flatMap((attempt) => (attempt.handoff ? [attempt.handoff] : [])) ?? []),
			...task.attempts.flatMap((attempt) => (attempt.handoff ? [attempt.handoff] : [])),
			...descendants.flatMap((descendant) =>
				descendant.attempts.flatMap((attempt) => (attempt.handoff ? [attempt.handoff] : [])),
			),
		].slice(-AGENT_TASK_CONTEXT_HANDOFF_MAX_ITEMS);
	}

	private findTask(taskId: string): AgentTask {
		const normalized = normalizeIdentifier(taskId, "taskId");
		const task = this.state.tasks.find((candidate) => candidate.id === normalized);
		if (!task) throw new AgentTaskGraphError(`unknown task: ${normalized}`);
		return task;
	}

	private childrenOf(taskId: string): AgentTask[] {
		return this.state.tasks.filter((task) => task.parentTaskId === taskId);
	}

	private isDescendant(taskId: string, candidateTaskId: string): boolean {
		let current = this.findTask(candidateTaskId);
		while (current.parentTaskId) {
			if (current.parentTaskId === taskId) return true;
			current = this.findTask(current.parentTaskId);
		}
		return false;
	}

	private findAvailableSupervisor(task: AgentTask): AgentTask | undefined {
		let current = task.parentTaskId ? this.findTask(task.parentTaskId) : undefined;
		while (current) {
			if (ACTIVE_TASK_STATUSES.has(current.status) && current.status !== "blocked") return current;
			current = current.parentTaskId ? this.findTask(current.parentTaskId) : undefined;
		}
		return undefined;
	}

	private requestSupervision(supervisor: AgentTask, requestedAt: string): AgentTask | undefined {
		const pendingRequest = supervisor.resumeRequest?.status === "pending" ? supervisor.resumeRequest : undefined;
		if (pendingRequest?.reason === "supervision_required") return undefined;
		const resumedGapIds = pendingRequest?.reason === "gap_resolution" ? pendingRequest.gapIds : [];
		return touchTask({
			...supervisor,
			status: "pending",
			resumeRequest: {
				id: `resume-supervision-${randomUUID()}`,
				taskId: supervisor.id,
				ownerAgentId: supervisor.ownerAgentId,
				reason: "supervision_required",
				gapIds: resumedGapIds,
				gapCount: Math.max(supervisor.gaps.length, pendingRequest?.gapCount ?? 0),
				status: "pending",
				requestedAt,
			},
		});
	}

	private lineage(taskId: string): string[] {
		const lineage: string[] = [];
		let current: AgentTask | undefined = this.findTask(taskId);
		while (current) {
			lineage.unshift(current.id);
			current = current.parentTaskId
				? this.state.tasks.find((task) => task.id === current?.parentTaskId)
				: undefined;
		}
		return lineage;
	}

	private assertOwner(task: AgentTask, callerAgentId: string): void {
		if (task.ownerAgentId !== callerAgentId) {
			throw new AgentTaskGraphError(`agent ${callerAgentId} does not own task ${task.id}`);
		}
	}

	private assertCanSupervise(task: AgentTask, callerAgentId: string): void {
		if (callerAgentId === this.state.rootAgentId) return;
		let ancestor = task.parentTaskId ? this.findTask(task.parentTaskId) : undefined;
		while (ancestor) {
			if (ancestor.ownerAgentId === callerAgentId) return;
			ancestor = ancestor.parentTaskId ? this.findTask(ancestor.parentTaskId) : undefined;
		}
		throw new AgentTaskGraphError(`agent ${callerAgentId} is not an ancestor supervisor of task ${task.id}`);
	}

	private assertActive(task: AgentTask, operation: string): void {
		if (!ACTIVE_TASK_STATUSES.has(task.status)) {
			throw new AgentTaskGraphError(`cannot ${operation} task ${task.id} with status ${task.status}`);
		}
	}

	private assertWritable(): void {
		if (this.fatalError) {
			throw new AgentTaskGraphError(`task graph durability failed: ${this.fatalError.message}`, {
				cause: this.fatalError,
			});
		}
	}

	private assertSharedBudgetAvailable(): void {
		const budget = this.getSharedBudget();
		if (budget?.exhausted) {
			throw new AgentTaskGraphError(
				`task graph shared token budget is exhausted (${budget.usedTokens}/${budget.maxTotalTokens})`,
			);
		}
	}
}

export function formatAgentTaskContextEnvelope(envelope: AgentTaskContextEnvelope): string {
	return [
		"[task contract]",
		"You own this bounded task. Record a leaf-or-coordinator plan before exploration. Coordinators delegate genuinely narrower disjoint responsibility; leaves work directly.",
		"Reuse predecessor handoffs and shared evidence instead of rediscovering them. Persist a compact handoff containing all useful findings and remaining claims before yielding control.",
		JSON.stringify(envelope, null, 2),
	].join("\n\n");
}

function normalizeRootInput(input: AgentTaskRootInput): AgentTaskRootInput {
	return {
		...(input.id ? { id: normalizeIdentifier(input.id, "root.id") } : {}),
		ownerAgentId: normalizeIdentifier(input.ownerAgentId, "root.ownerAgentId"),
		objective: normalizeText(input.objective, "root.objective"),
		...(input.scope ? { scope: normalizeText(input.scope, "root.scope") } : {}),
		exclusiveClaims: normalizeClaims(input.exclusiveClaims ?? [], "root.exclusiveClaims"),
		sharedClaims: normalizeClaims(input.sharedClaims ?? [], "root.sharedClaims"),
		exclusions: normalizeClaims(input.exclusions ?? [], "root.exclusions"),
		questions: normalizeStringList(input.questions ?? [], "root.questions"),
		invariants: normalizeStringList(input.invariants ?? [], "root.invariants"),
		knownDecisions: normalizeStringList(input.knownDecisions ?? [], "root.knownDecisions"),
		dependencies: normalizeStringList(input.dependencies ?? [], "root.dependencies"),
		verificationExpectations: normalizeStringList(
			input.verificationExpectations ?? [],
			"root.verificationExpectations",
		),
		...(input.resultSchema ? { resultSchema: normalizeRecord(input.resultSchema, "root.resultSchema") } : {}),
		...(input.rootContext ? { rootContext: normalizeRecord(input.rootContext, "root.rootContext") } : {}),
		...(input.inheritedContext
			? { inheritedContext: normalizeRecord(input.inheritedContext, "root.inheritedContext") }
			: {}),
	};
}

function isMeaningfullyNarrower(parent: AgentTask, child: AgentTaskDelegationInput): boolean {
	const exclusiveClaims = child.exclusiveClaims ?? [];
	const transfersProperSubset = exclusiveClaims.length > 0 && exclusiveClaims.length < parent.exclusiveClaims.length;
	const ownsFocusedQuestion =
		(child.questions?.length ?? 0) > 0 &&
		(child.scope.trim() !== parent.scope.trim() || child.objective.trim() !== parent.objective.trim());
	return transfersProperSubset || ownsFocusedQuestion;
}

function normalizeDelegationInput(input: AgentTaskDelegationInput): AgentTaskDelegationInput & {
	questions: string[];
	invariants: string[];
	knownDecisions: string[];
	dependencies: string[];
	verificationExpectations: string[];
} {
	return {
		...(input.id ? { id: normalizeIdentifier(input.id, "task.id") } : {}),
		objective: normalizeText(input.objective, "task.objective"),
		scope: normalizeText(input.scope, "task.scope"),
		exclusiveClaims: normalizeClaims(input.exclusiveClaims ?? [], "task.exclusiveClaims"),
		sharedClaims: normalizeClaims(input.sharedClaims ?? [], "task.sharedClaims"),
		exclusions: normalizeClaims(input.exclusions ?? [], "task.exclusions"),
		questions: normalizeStringList(input.questions ?? [], "task.questions"),
		invariants: normalizeStringList(input.invariants ?? [], "task.invariants"),
		knownDecisions: normalizeStringList(input.knownDecisions ?? [], "task.knownDecisions"),
		dependencies: normalizeStringList(input.dependencies ?? [], "task.dependencies"),
		verificationExpectations: normalizeStringList(
			input.verificationExpectations ?? [],
			"task.verificationExpectations",
		),
		...(input.resultSchema ? { resultSchema: normalizeRecord(input.resultSchema, "task.resultSchema") } : {}),
		delegationReason: normalizeText(input.delegationReason, "task.delegationReason"),
		...(input.contractKey ? { contractKey: normalizeIdentifier(input.contractKey, "task.contractKey") } : {}),
		...(input.predecessorTaskId
			? { predecessorTaskId: normalizeIdentifier(input.predecessorTaskId, "task.predecessorTaskId") }
			: {}),
		...(input.repeatReason ? { repeatReason: normalizeRepeatReason(input.repeatReason) } : {}),
	};
}

function normalizeTaskResult(result: AgentTaskResult): AgentTaskResult {
	const normalized: AgentTaskResult = {
		summary: normalizeText(result.summary, "result.summary"),
		verification: normalizeUnknownList(result.verification, "result.verification"),
		candidateFindings: normalizeUnknownList(result.candidateFindings, "result.candidateFindings"),
		unresolvedQuestions: normalizeStringList(result.unresolvedQuestions, "result.unresolvedQuestions"),
		coverageGaps: normalizeUnknownList(result.coverageGaps, "result.coverageGaps"),
		evidenceRefs: normalizeStringList(result.evidenceRefs, "result.evidenceRefs"),
		...(result.data ? { data: normalizeRecord(result.data, "result.data") } : {}),
	};
	assertJsonSize(normalized, "task result", AGENT_TASK_RESULT_MAX_BYTES);
	return normalized;
}

function normalizeClaims(claims: AgentTaskResourceClaim[], field: string): AgentTaskResourceClaim[] {
	if (!Array.isArray(claims)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (claims.length > AGENT_TASK_CLAIM_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_CLAIM_MAX_ITEMS} items`);
	}
	const normalized = claims.map((claim, index) => {
		if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
			throw new AgentTaskGraphError(`${field}[${index}] must be an object`);
		}
		return {
			namespace: normalizeIdentifier(claim.namespace, `${field}[${index}].namespace`),
			key: normalizeText(claim.key, `${field}[${index}].key`, AGENT_TASK_TEXT_MAX_LENGTH),
			...(claim.metadata ? { metadata: normalizeRecord(claim.metadata, `${field}[${index}].metadata`) } : {}),
		};
	});
	const keys = new Set<string>();
	for (const claim of normalized) {
		const key = claimKey(claim);
		if (keys.has(key)) throw new AgentTaskGraphError(`${field} contains duplicate claim ${key}`);
		keys.add(key);
	}
	return normalized;
}

function normalizeStringList(values: string[], field: string): string[] {
	if (!Array.isArray(values)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (values.length > AGENT_TASK_LIST_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_LIST_MAX_ITEMS} items`);
	}
	return values.map((value, index) => normalizeText(value, `${field}[${index}]`));
}

function normalizeUnknownList(values: unknown[], field: string): unknown[] {
	if (!Array.isArray(values)) throw new AgentTaskGraphError(`${field} must be an array`);
	if (values.length > AGENT_TASK_LIST_MAX_ITEMS) {
		throw new AgentTaskGraphError(`${field} must contain at most ${AGENT_TASK_LIST_MAX_ITEMS} items`);
	}
	assertJsonSize(values, field, AGENT_TASK_RESULT_MAX_BYTES);
	return clone(values);
}

function normalizeRecord(value: Record<string, unknown>, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentTaskGraphError(`${field} must be an object`);
	}
	assertJsonSize(value, field, AGENT_TASK_RESULT_MAX_BYTES);
	return clone(value);
}

function normalizeText(value: string, field: string, maxLength = AGENT_TASK_TEXT_MAX_LENGTH): string {
	if (typeof value !== "string") throw new AgentTaskGraphError(`${field} must be a string`);
	const normalized = value.trim();
	if (!normalized) throw new AgentTaskGraphError(`${field} must not be empty`);
	if (normalized.length > maxLength) throw new AgentTaskGraphError(`${field} must be at most ${maxLength} characters`);
	return normalized;
}

function normalizeAgentTaskGraphPolicy(policy: AgentTaskGraphPolicy | undefined): AgentTaskGraphPolicy {
	if (policy === undefined) return {};
	if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
		throw new AgentTaskGraphError("task graph policy must be an object");
	}
	assertExactObjectKeys(policy, "task graph policy", [
		"requireExclusiveClaims",
		"requireDelegatedTaskPlan",
		"requireDelegationContractKey",
		"maxTotalTokens",
		"validateDelegation",
		"validateCompletion",
		"delegatedTaskConvergence",
		"delegatedTaskCompletionCorrection",
		"executionProfile",
	]);
	if (policy.requireExclusiveClaims !== undefined && typeof policy.requireExclusiveClaims !== "boolean") {
		throw new AgentTaskGraphError("requireExclusiveClaims must be a boolean");
	}
	for (const field of ["requireDelegatedTaskPlan", "requireDelegationContractKey"] as const) {
		if (policy[field] !== undefined && typeof policy[field] !== "boolean") {
			throw new AgentTaskGraphError(`${field} must be a boolean`);
		}
	}
	if (
		policy.maxTotalTokens !== undefined &&
		(!Number.isSafeInteger(policy.maxTotalTokens) || policy.maxTotalTokens < 1)
	) {
		throw new AgentTaskGraphError("maxTotalTokens must be a positive integer");
	}
	for (const field of ["validateDelegation", "validateCompletion"] as const) {
		if (policy[field] !== undefined && typeof policy[field] !== "function") {
			throw new AgentTaskGraphError(`${field} must be a function`);
		}
	}
	const convergence = policy.delegatedTaskConvergence;
	if (convergence !== undefined) {
		if (!convergence || typeof convergence !== "object" || Array.isArray(convergence)) {
			throw new AgentTaskGraphError("delegatedTaskConvergence must be an object");
		}
		assertExactObjectKeys(convergence, "delegatedTaskConvergence", [
			"maxToolCallsWithoutEvidence",
			"maxToolCallsAfterSteer",
			"maxExplorationToolCalls",
		]);
		for (const field of ["maxToolCallsWithoutEvidence", "maxToolCallsAfterSteer"] as const) {
			const value = convergence[field];
			if (!Number.isSafeInteger(value) || value < 1) {
				throw new AgentTaskGraphError(`delegatedTaskConvergence.${field} must be a positive integer`);
			}
		}
		if (
			convergence.maxExplorationToolCalls !== undefined &&
			(!Number.isSafeInteger(convergence.maxExplorationToolCalls) || convergence.maxExplorationToolCalls < 1)
		) {
			throw new AgentTaskGraphError("delegatedTaskConvergence.maxExplorationToolCalls must be a positive integer");
		}
	}
	if (
		policy.delegatedTaskCompletionCorrection !== undefined &&
		typeof policy.delegatedTaskCompletionCorrection !== "boolean"
	) {
		throw new AgentTaskGraphError("delegatedTaskCompletionCorrection must be a boolean");
	}
	if (policy.executionProfile !== undefined && policy.executionProfile !== "inspection_only") {
		throw new AgentTaskGraphError("executionProfile must be inspection_only when provided");
	}
	return {
		...policy,
		...(convergence !== undefined ? { delegatedTaskConvergence: { ...convergence } } : {}),
	};
}

function assertExactObjectKeys(value: object, field: string, expectedKeys: readonly string[]): void {
	const expected = new Set(expectedKeys);
	const unknown = Object.keys(value).filter((key) => !expected.has(key));
	if (unknown.length > 0) {
		throw new AgentTaskGraphError(`${field} contains unsupported fields: ${unknown.join(", ")}`);
	}
}

function normalizeIdentifier(value: string, field: string): string {
	const normalized = normalizeText(value, field, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
		throw new AgentTaskGraphError(`${field} contains unsupported characters`);
	}
	return normalized;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value < 0) throw new AgentTaskGraphError(`${field} must be a non-negative integer`);
	return value;
}

function normalizeIntegerInRange(value: number, field: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new AgentTaskGraphError(`${field} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function normalizeUsageNumber(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0)
		throw new AgentTaskGraphError("task usage values must be finite non-negative numbers");
	return value;
}

function emptyUsage(): AgentTaskUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageDelta(
	task: AgentTask,
	delta: AgentTaskUsage,
	updatedAt = new Date().toISOString(),
	taskVersion = task.version + 1,
	attribution?: Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model">,
): AgentTask {
	const usageAttributions = [...(task.usageAttributions ?? [])];
	if (attribution) {
		const index = usageAttributions.findIndex(
			(candidate) => candidate.agentId === attribution.agentId && candidate.model === attribution.model,
		);
		const current = index >= 0 ? usageAttributions[index]! : undefined;
		const next: AgentTaskUsageAttribution = {
			...attribution,
			calls: (current?.calls ?? 0) + 1,
			usage: addUsage(current?.usage ?? emptyUsage(), delta),
		};
		if (index >= 0) usageAttributions[index] = next;
		else usageAttributions.push(next);
	}
	return {
		...task,
		usage: addUsage(task.usage, delta),
		usageAttributions,
		version: taskVersion,
		updatedAt,
	};
}

function addUsage(current: AgentTaskUsage, delta: AgentTaskUsage): AgentTaskUsage {
	return {
		input: current.input + delta.input,
		output: current.output + delta.output,
		cacheRead: current.cacheRead + delta.cacheRead,
		cacheWrite: current.cacheWrite + delta.cacheWrite,
		cost: current.cost + delta.cost,
	};
}

function normalizeUsageAttributions(task: AgentTask): AgentTask {
	const evidence = Array.isArray(task.evidence) ? task.evidence.map(normalizeStoredEvidence) : [];
	const attempts =
		Array.isArray(task.attempts) && task.attempts.length > 0
			? task.attempts.map(normalizeStoredAttempt)
			: [legacyAttempt(task, evidence)];
	return {
		...task,
		...(task.contractKey ? { contractKey: normalizeIdentifier(task.contractKey, "task contractKey") } : {}),
		...(task.predecessorTaskId
			? { predecessorTaskId: normalizeIdentifier(task.predecessorTaskId, "task predecessorTaskId") }
			: {}),
		...(task.repeatReason ? { repeatReason: normalizeRepeatReason(task.repeatReason) } : {}),
		evidence,
		attempts,
		...(task.plan ? { plan: normalizeStoredPlan(task.plan) } : {}),
		...(task.convergence ? { convergence: normalizeConvergenceState(task.convergence) } : {}),
		usageAttributions: Array.isArray(task.usageAttributions)
			? task.usageAttributions.map((attribution) => ({
					...attribution,
					...normalizeUsageAttribution(attribution),
				}))
			: [],
	};
}

function emptyConvergenceState(): AgentTaskConvergenceState {
	return {
		phase: "exploring",
		explorationToolCalls: 0,
		toolCallsWithoutEvidence: 0,
		finalizingToolCalls: 0,
		seenEvidenceRefs: [],
	};
}

function normalizeConvergenceState(state: AgentTaskConvergenceState): AgentTaskConvergenceState {
	if (state.phase !== "exploring" && state.phase !== "finalizing") {
		throw new AgentTaskGraphError(`unsupported task convergence phase: ${String(state.phase)}`);
	}
	return {
		phase: state.phase,
		explorationToolCalls: normalizeNonNegativeInteger(
			state.explorationToolCalls,
			"task convergence explorationToolCalls",
		),
		toolCallsWithoutEvidence: normalizeNonNegativeInteger(
			state.toolCallsWithoutEvidence,
			"task convergence toolCallsWithoutEvidence",
		),
		finalizingToolCalls: normalizeNonNegativeInteger(
			state.finalizingToolCalls,
			"task convergence finalizingToolCalls",
		),
		seenEvidenceRefs: normalizeStringList(state.seenEvidenceRefs, "task convergence seenEvidenceRefs"),
	};
}

function normalizeUsageAttribution(
	attribution?: Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model">,
): Pick<AgentTaskUsageAttribution, "agentId" | "agentKind" | "model"> | undefined {
	if (!attribution) return undefined;
	if (attribution.agentKind !== undefined && attribution.agentKind !== "root" && attribution.agentKind !== "child") {
		throw new AgentTaskGraphError(`unsupported usage attribution agent kind: ${attribution.agentKind}`);
	}
	return {
		agentId: normalizeIdentifier(attribution.agentId, "usage attribution agentId"),
		...(attribution.agentKind ? { agentKind: attribution.agentKind } : {}),
		model: normalizeText(attribution.model, "usage attribution model", 256),
	};
}

function boundedRuntimeText(value: string, fallback: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	const source = normalized || fallback;
	if (source.length <= AGENT_TASK_TEXT_MAX_LENGTH) return source;
	const marker = "\n\n[truncated by task runtime]";
	return `${source.slice(0, AGENT_TASK_TEXT_MAX_LENGTH - marker.length).trimEnd()}${marker}`;
}

function rootContextDescriptor(context: Record<string, unknown>): AgentTaskRootContextDescriptor {
	const encoded = JSON.stringify(context);
	return {
		sha256: createHash("sha256").update(encoded).digest("hex"),
		byteLength: Buffer.byteLength(encoded, "utf8"),
	};
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function touchTask(task: AgentTask): AgentTask {
	return { ...task, version: task.version + 1, updatedAt: new Date().toISOString() };
}

function sameClaim(left: AgentTaskResourceClaim, right: AgentTaskResourceClaim): boolean {
	return left.namespace === right.namespace && left.key === right.key;
}

function claimKey(claim: AgentTaskResourceClaim): string {
	return `${claim.namespace}:${claim.key}`;
}

function mergeClaims(left: AgentTaskResourceClaim[], right: AgentTaskResourceClaim[]): AgentTaskResourceClaim[] {
	const merged = [...left];
	for (const claim of right) {
		if (!merged.some((candidate) => sameClaim(candidate, claim))) merged.push(clone(claim));
	}
	return merged;
}

function mergeStrings(left: string[], right: string[]): string[] {
	return [...new Set([...left, ...right])];
}

function createAttempt(
	agentId: string,
	status: AgentTaskAttempt["status"],
	predecessorAttemptId?: string,
): AgentTaskAttempt {
	const now = new Date().toISOString();
	return {
		id: `attempt-${randomUUID()}`,
		agentId: normalizeIdentifier(agentId, "attempt.agentId"),
		status,
		...(predecessorAttemptId ? { predecessorAttemptId } : {}),
		...(status === "running" ? { startedAt: now } : {}),
	};
}

function currentAttempt(task: AgentTask): AgentTaskAttempt | undefined {
	return task.attempts.at(-1);
}

function requireCurrentAttempt(task: AgentTask): AgentTaskAttempt {
	const attempt = currentAttempt(task);
	if (!attempt) throw new AgentTaskGraphError(`task ${task.id} has no current attempt`);
	return attempt;
}

function updateCurrentAttempt(
	task: AgentTask,
	callerAgentId: string,
	update: (attempt: AgentTaskAttempt) => AgentTaskAttempt,
): AgentTaskAttempt[] {
	const attempt = requireCurrentAttempt(task);
	if (attempt.agentId !== callerAgentId) {
		throw new AgentTaskGraphError(`agent ${callerAgentId} does not own current attempt ${attempt.id}`);
	}
	return [...task.attempts.slice(0, -1), update(attempt)];
}

function finishCurrentAttempt(
	task: AgentTask,
	callerAgentId: string,
	status: "completed" | "interrupted" | "cancelled" | "replaced",
	handoff: AgentTaskHandoff,
): AgentTaskAttempt[] {
	return updateCurrentAttempt(task, callerAgentId, (attempt) => ({
		...attempt,
		status,
		startedAt: attempt.startedAt ?? attempt.endedAt ?? new Date().toISOString(),
		endedAt: new Date().toISOString(),
		handoff,
	}));
}

function rebindActiveAttempt(task: AgentTask, newOwnerAgentId: string, reason: string): AgentTaskAttempt[] {
	const current = requireCurrentAttempt(task);
	if (current.agentId === newOwnerAgentId) return task.attempts;
	const handoff = normalizeTaskHandoff(fallbackHandoff(task, reason), task);
	return [
		...finishCurrentAttempt(task, current.agentId, "replaced", handoff),
		createAttempt(newOwnerAgentId, task.status === "running" ? "running" : "pending", current.id),
	];
}

function normalizeTaskPlan(plan: Omit<AgentTaskPlan, "recordedAt">): Omit<AgentTaskPlan, "recordedAt"> {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
		throw new AgentTaskGraphError("task plan must be an object");
	}
	if (plan.mode !== "leaf" && plan.mode !== "coordinator") {
		throw new AgentTaskGraphError("task plan mode must be leaf or coordinator");
	}
	return {
		mode: plan.mode,
		rationale: normalizeText(plan.rationale, "task plan rationale"),
		boundaries: normalizeStringList(plan.boundaries ?? [], "task plan boundaries"),
		expectedEvidence: normalizeStringList(plan.expectedEvidence ?? [], "task plan expectedEvidence"),
	};
}

function normalizeStoredPlan(plan: AgentTaskPlan): AgentTaskPlan {
	return {
		...normalizeTaskPlan(plan),
		recordedAt: normalizeTimestamp(plan.recordedAt, "task plan recordedAt"),
	};
}

function normalizeTaskEvidenceInput(input: AgentTaskEvidenceInput): AgentTaskEvidenceInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AgentTaskGraphError("task evidence must be an object");
	}
	const digest = normalizeText(input.contentDigest, "task evidence contentDigest", 128).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(digest)) {
		throw new AgentTaskGraphError("task evidence contentDigest must be a lowercase SHA-256 digest");
	}
	return {
		kind: normalizeIdentifier(input.kind, "task evidence kind"),
		subjects: normalizeStringList(input.subjects, "task evidence subjects"),
		...(input.claims ? { claims: normalizeClaims(input.claims, "task evidence claims") } : {}),
		contentDigest: digest,
		...(input.summary ? { summary: normalizeText(input.summary, "task evidence summary") } : {}),
		...(input.artifactRef ? { artifactRef: normalizeText(input.artifactRef, "task evidence artifactRef") } : {}),
	};
}

function normalizeStoredEvidence(evidence: AgentTaskEvidence): AgentTaskEvidence {
	return {
		...normalizeTaskEvidenceInput(evidence),
		id: normalizeIdentifier(evidence.id, "task evidence id"),
		producedByTaskId: normalizeIdentifier(evidence.producedByTaskId, "task evidence producedByTaskId"),
		producedByAttemptId: normalizeIdentifier(evidence.producedByAttemptId, "task evidence producedByAttemptId"),
		createdAt: normalizeTimestamp(evidence.createdAt, "task evidence createdAt"),
	};
}

function evidenceIdentity(evidence: AgentTaskEvidenceInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: evidence.kind,
				subjects: [...evidence.subjects].sort(),
				claims: [...(evidence.claims ?? [])].map(claimKey).sort(),
				contentDigest: evidence.contentDigest,
			}),
		)
		.digest("hex");
}

function normalizeTaskHandoff(input: AgentTaskHandoffInput, task: AgentTask): AgentTaskHandoff {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AgentTaskGraphError("task handoff must be an object");
	}
	const inspectedClaims = normalizeClaims(input.inspectedClaims ?? [], "task handoff inspectedClaims");
	const remainingClaims = normalizeClaims(
		input.remainingClaims ?? task.exclusiveClaims,
		"task handoff remainingClaims",
	);
	for (const claim of [...inspectedClaims, ...remainingClaims]) {
		if (!task.exclusiveClaims.some((owned) => sameClaim(owned, claim))) {
			throw new AgentTaskGraphError(`task handoff claim ${claimKey(claim)} is not owned by task ${task.id}`);
		}
	}
	const overlap = inspectedClaims.find((claim) => remainingClaims.some((remaining) => sameClaim(claim, remaining)));
	if (overlap)
		throw new AgentTaskGraphError(`task handoff claim appears inspected and remaining: ${claimKey(overlap)}`);
	const evidenceIds = normalizeStringList(
		input.evidenceIds ?? task.progress?.evidenceRefs ?? [],
		"task handoff evidenceIds",
	);
	const handoff: AgentTaskHandoff = {
		summary: normalizeText(input.summary, "task handoff summary"),
		inspectedClaims,
		remainingClaims,
		evidenceIds,
		candidateFindings: normalizeUnknownList(input.candidateFindings ?? [], "task handoff candidateFindings"),
		rejectedHypotheses: normalizeStringList(input.rejectedHypotheses ?? [], "task handoff rejectedHypotheses"),
		verification: normalizeUnknownList(input.verification ?? [], "task handoff verification"),
		unresolvedQuestions: normalizeStringList(input.unresolvedQuestions ?? [], "task handoff unresolvedQuestions"),
		recommendedNextScopes: normalizeStringList(
			input.recommendedNextScopes ?? [],
			"task handoff recommendedNextScopes",
		),
		createdAt: new Date().toISOString(),
	};
	assertJsonSize(handoff, "task handoff", AGENT_TASK_HANDOFF_MAX_BYTES);
	return handoff;
}

function fallbackHandoff(task: AgentTask, reason: string): AgentTaskHandoffInput {
	const drafted = currentAttempt(task)?.handoff;
	if (drafted) {
		return {
			...drafted,
			summary: boundedRuntimeText(`${reason}. ${drafted.summary}`, reason),
			inspectedClaims: drafted.inspectedClaims.filter((claim) =>
				task.exclusiveClaims.some((owned) => sameClaim(owned, claim)),
			),
			remainingClaims: drafted.remainingClaims.filter((claim) =>
				task.exclusiveClaims.some((owned) => sameClaim(owned, claim)),
			),
		};
	}
	return {
		summary: boundedRuntimeText(
			task.progress?.summary ? `${reason}. Last durable progress: ${task.progress.summary}` : reason,
			"Task ended before producing a model-authored handoff.",
		),
		remainingClaims: task.exclusiveClaims,
		evidenceIds: task.progress?.evidenceRefs ?? [],
		unresolvedQuestions: task.questions.filter(
			(question) => !(task.progress?.completedQuestions ?? []).includes(question),
		),
	};
}

function handoffFromResult(task: AgentTask, result: AgentTaskResult): AgentTaskHandoff {
	return normalizeTaskHandoff(
		{
			summary: result.summary,
			inspectedClaims: task.exclusiveClaims,
			remainingClaims: [],
			evidenceIds: mergeStrings(task.progress?.evidenceRefs ?? [], result.evidenceRefs),
			candidateFindings: result.candidateFindings,
			verification: result.verification,
			unresolvedQuestions: result.unresolvedQuestions,
		},
		task,
	);
}

function handoffFromRejectedResult(task: AgentTask, result: AgentTaskResult): AgentTaskHandoff {
	return normalizeTaskHandoff(
		{
			summary: result.summary,
			remainingClaims: task.exclusiveClaims,
			evidenceIds: mergeStrings(task.progress?.evidenceRefs ?? [], result.evidenceRefs),
			candidateFindings: result.candidateFindings,
			verification: result.verification,
			unresolvedQuestions: result.unresolvedQuestions,
		},
		task,
	);
}

function lastHandoff(task: AgentTask): AgentTaskHandoff | undefined {
	return [...task.attempts].reverse().find((attempt) => attempt.handoff)?.handoff;
}

function normalizeStoredAttempt(attempt: AgentTaskAttempt): AgentTaskAttempt {
	if (!["pending", "running", "completed", "interrupted", "cancelled", "replaced"].includes(attempt.status)) {
		throw new AgentTaskGraphError(`unsupported task attempt status: ${String(attempt.status)}`);
	}
	const handoff = attempt.handoff ? normalizeStoredHandoff(attempt.handoff) : undefined;
	return {
		id: normalizeIdentifier(attempt.id, "task attempt id"),
		agentId: normalizeIdentifier(attempt.agentId, "task attempt agentId"),
		status: attempt.status,
		...(attempt.predecessorAttemptId
			? {
					predecessorAttemptId: normalizeIdentifier(
						attempt.predecessorAttemptId,
						"task attempt predecessorAttemptId",
					),
				}
			: {}),
		...(attempt.startedAt ? { startedAt: normalizeTimestamp(attempt.startedAt, "task attempt startedAt") } : {}),
		...(attempt.endedAt ? { endedAt: normalizeTimestamp(attempt.endedAt, "task attempt endedAt") } : {}),
		...(handoff ? { handoff } : {}),
	};
}

function normalizeStoredHandoff(handoff: AgentTaskHandoff): AgentTaskHandoff {
	const normalized: AgentTaskHandoff = {
		summary: normalizeText(handoff.summary, "task handoff summary"),
		inspectedClaims: normalizeClaims(handoff.inspectedClaims, "task handoff inspectedClaims"),
		remainingClaims: normalizeClaims(handoff.remainingClaims, "task handoff remainingClaims"),
		evidenceIds: normalizeStringList(handoff.evidenceIds, "task handoff evidenceIds"),
		candidateFindings: normalizeUnknownList(handoff.candidateFindings, "task handoff candidateFindings"),
		rejectedHypotheses: normalizeStringList(handoff.rejectedHypotheses, "task handoff rejectedHypotheses"),
		verification: normalizeUnknownList(handoff.verification, "task handoff verification"),
		unresolvedQuestions: normalizeStringList(handoff.unresolvedQuestions, "task handoff unresolvedQuestions"),
		recommendedNextScopes: normalizeStringList(handoff.recommendedNextScopes, "task handoff recommendedNextScopes"),
		createdAt: normalizeTimestamp(handoff.createdAt, "task handoff createdAt"),
	};
	assertJsonSize(normalized, "task handoff", AGENT_TASK_HANDOFF_MAX_BYTES);
	return normalized;
}

function legacyAttempt(task: AgentTask, evidence: AgentTaskEvidence[]): AgentTaskAttempt {
	const status =
		task.status === "completed"
			? "completed"
			: task.status === "interrupted"
				? "interrupted"
				: task.status === "cancelled"
					? "cancelled"
					: task.status === "running"
						? "running"
						: "pending";
	const terminal = status === "completed" || status === "interrupted" || status === "cancelled";
	const result = task.result;
	const handoff = terminal
		? {
				summary: result?.summary ?? "Migrated legacy task attempt",
				inspectedClaims: status === "completed" ? clone(task.exclusiveClaims) : [],
				remainingClaims: status === "completed" ? [] : clone(task.exclusiveClaims),
				evidenceIds: result?.evidenceRefs ?? evidence.map((item) => item.id),
				candidateFindings: result?.candidateFindings ?? [],
				rejectedHypotheses: [],
				verification: result?.verification ?? [],
				unresolvedQuestions: result?.unresolvedQuestions ?? [],
				recommendedNextScopes: [],
				createdAt: task.updatedAt,
			}
		: undefined;
	return {
		id: `attempt-legacy-${createHash("sha256").update(task.id).digest("hex").slice(0, 24)}`,
		agentId: task.ownerAgentId,
		status,
		...(status === "running" || terminal ? { startedAt: task.createdAt } : {}),
		...(terminal ? { endedAt: task.updatedAt } : {}),
		...(handoff ? { handoff } : {}),
	};
}

function normalizeTimestamp(value: string, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new AgentTaskGraphError(`${field} must be an ISO timestamp`);
	}
	return value;
}

function normalizeRepeatReason(
	value: AgentTaskDelegationInput["repeatReason"],
): NonNullable<AgentTaskDelegationInput["repeatReason"]> {
	if (
		value !== "remaining_scope" &&
		value !== "recorded_gap" &&
		value !== "contradiction" &&
		value !== "new_cross_boundary_question"
	) {
		throw new AgentTaskGraphError(`unsupported task repeatReason: ${String(value)}`);
	}
	return value;
}

function delegationSignature(parentTaskId: string, task: AgentTaskDelegationInput): string {
	return JSON.stringify({
		parentTaskId,
		scope: task.scope.toLowerCase(),
		exclusiveClaims: (task.exclusiveClaims ?? []).map(claimKey).sort(),
		questions: (task.questions ?? []).map((question) => question.toLowerCase()).sort(),
	});
}

function taskSignature(task: AgentTask): string {
	return JSON.stringify({
		parentTaskId: task.parentTaskId,
		scope: task.scope.toLowerCase(),
		exclusiveClaims: task.exclusiveClaims.map(claimKey).sort(),
		questions: task.questions.map((question) => question.toLowerCase()).sort(),
	});
}

function historicallyOverlaps(task: AgentTask, candidate: AgentTaskDelegationInput): boolean {
	return task.exclusiveClaims.some((claim) =>
		(candidate.exclusiveClaims ?? []).some((candidateClaim) => sameClaim(claim, candidateClaim)),
	);
}

function compareTasks(left: AgentTask, right: AgentTask): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function deduplicateTasks(tasks: AgentTask[]): AgentTask[] {
	const deduplicated = new Map<string, AgentTask>();
	for (const task of tasks) deduplicated.set(task.id, task);
	return [...deduplicated.values()];
}

function parseSnapshot(raw: string): AgentTaskGraphSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new AgentTaskGraphError(`invalid task graph snapshot: ${String(error)}`, { cause: asError(error) });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AgentTaskGraphError("task graph snapshot must be an object");
	}
	const snapshot = value as Partial<AgentTaskGraphSnapshot>;
	if (snapshot.schemaVersion !== AGENT_TASK_GRAPH_SCHEMA_VERSION) {
		throw new AgentTaskGraphError(`unsupported task graph schema version: ${String(snapshot.schemaVersion)}`);
	}
	if (
		typeof snapshot.graphId !== "string" ||
		typeof snapshot.rootTaskId !== "string" ||
		typeof snapshot.rootAgentId !== "string"
	) {
		throw new AgentTaskGraphError("task graph snapshot is missing identity fields");
	}
	if (!Number.isInteger(snapshot.version) || !Array.isArray(snapshot.tasks)) {
		throw new AgentTaskGraphError("task graph snapshot is missing version or tasks");
	}
	return clone({
		...(snapshot as AgentTaskGraphSnapshot),
		tasks: (snapshot.tasks as AgentTask[]).map(normalizeUsageAttributions),
	});
}

function assertJsonSize(value: unknown, field: string, maximum: number): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		throw new AgentTaskGraphError(`${field} must be JSON serializable: ${String(error)}`, {
			cause: asError(error),
		});
	}
	if (Buffer.byteLength(encoded, "utf8") > maximum) {
		throw new AgentTaskGraphError(`${field} must be at most ${maximum} UTF-8 bytes`);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
