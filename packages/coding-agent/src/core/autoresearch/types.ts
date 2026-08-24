import type {
	WorkflowArtifactRef,
	WorkflowAutoResearchEventPayload,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowImprovementProposal,
	WorkflowJournalCommit,
	WorkflowResourceVector,
	WorkflowRevisionResolution,
	WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";

/** The exact top-level keys retained by the compatible AutoResearch v2 run file. */
export const V2_RUN_KEYS = [
	"schema_version",
	"run_id",
	"created_at",
	"repo",
	"branch",
	"goal",
	"scope",
	"metric",
	"guard",
	"target",
	"max_candidates",
	"timeout_seconds",
	"docs",
	"parallel",
] as const;

export const V2_SCHEMA_VERSION = 2 as const;

export type V2MetricDirection = "lower" | "higher";

export interface V2Metric {
	name: string;
	direction: V2MetricDirection;
	command: string;
	json_key: string | null;
}

export type V2Guard = Record<string, unknown>;

export interface V2Docs {
	goal_path: string;
	decisions_path: string;
	goal_sha256: string;
	decisions_sha256: string;
}

export interface V2ParallelAllocation {
	window: number;
	min_per_role: number;
	plateau_k: number;
}

export interface V2Parallel {
	max_parallel: number | "bank";
	max_parallel_resolved: number;
	worktree_root: string;
	prepare: string | null;
	lease_seconds: number;
	allocation: V2ParallelAllocation;
}

export interface V2Run {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	created_at: string;
	repo: string;
	branch: string;
	goal: string;
	scope: readonly string[];
	metric: V2Metric;
	guard: V2Guard | null;
	target: number;
	max_candidates: number | null;
	timeout_seconds: number;
	docs: V2Docs;
	parallel: V2Parallel;
}

export interface V2BaselineEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "baseline";
	head: string;
	metric: number;
	verify_log: string;
	guard_log: string | null;
}

export interface V2CandidateGrant {
	source_id: string;
	kind: "cores" | "agents" | "node";
	cores?: number;
	slots?: number;
	capacity?: number;
	label: string;
}

export interface V2CandidateStartedEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "candidate_started";
	candidate: number;
	base_commit: string;
	base_metric: number;
	slot: number;
	role: "exploit" | "explore";
	role_source: string;
	grant: V2CandidateGrant;
	branch: string;
	lease_expires_at: number;
	goal_sha256: string;
	decisions_sha256: string;
}

export interface V2CandidateResolvedEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "candidate_resolved";
	candidate: number;
	outcome: "admitted" | "discarded" | "failed" | "abandoned" | "reaped";
	reason: string;
	description: string;
	trial_metric: number | null;
	retained_metric: number | null;
	trial_commit: string | null;
	trial_branch: string | null;
	head: string;
	guard: "pass" | "fail" | "not_run";
	verify_log: string;
	guard_log: string | null;
}

export interface V2CompleteEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "complete";
	reason: string;
	head: string;
	metric: number;
	unresolved_candidates: readonly number[];
}

export interface V2BlockedEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "blocked";
	reason: string;
	head: string;
	metric: number;
	unresolved_candidates: readonly number[];
}

export interface V2ErrorEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "error";
	reason: string;
	head: string;
	metric: number;
	trial_commit: string | null;
	log: string;
	unresolved_candidates: readonly number[];
}

export interface V2StoppedEvent {
	schema_version: typeof V2_SCHEMA_VERSION;
	run_id: string;
	seq: number;
	time: string;
	event: "stopped";
	reason: string;
	head: string;
	metric: number;
	unresolved_candidates: readonly number[];
}

export type V2Event =
	| V2BaselineEvent
	| V2CandidateStartedEvent
	| V2CandidateResolvedEvent
	| V2CompleteEvent
	| V2BlockedEvent
	| V2ErrorEvent
	| V2StoppedEvent;

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(record).sort();
	const keys = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(keys)) throw new Error(`${label} has unexpected fields`);
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
		throw new Error(`${label} must be finite and bounded`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error(`${label} must be a positive integer`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a non-negative integer`);
	return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0))
		throw new Error(`${label} must be an array of strings`);
	return value;
}

function parseMetric(value: unknown): V2Metric {
	const record = asRecord(value, "metric");
	exactKeys(record, ["name", "direction", "command", "json_key"], "metric");
	const direction = record.direction;
	if (direction !== "lower" && direction !== "higher") throw new Error("metric direction is invalid");
	if (record.json_key !== null && typeof record.json_key !== "string") throw new Error("metric json_key is invalid");
	return {
		name: stringValue(record.name, "metric.name"),
		direction,
		command: stringValue(record.command, "metric.command"),
		json_key: record.json_key,
	};
}

function parseDocs(value: unknown): V2Docs {
	const record = asRecord(value, "docs");
	exactKeys(record, ["goal_path", "decisions_path", "goal_sha256", "decisions_sha256"], "docs");
	return {
		goal_path: stringValue(record.goal_path, "docs.goal_path"),
		decisions_path: stringValue(record.decisions_path, "docs.decisions_path"),
		goal_sha256: stringValue(record.goal_sha256, "docs.goal_sha256"),
		decisions_sha256: stringValue(record.decisions_sha256, "docs.decisions_sha256"),
	};
}

function parseParallel(value: unknown): V2Parallel {
	const record = asRecord(value, "parallel");
	exactKeys(
		record,
		["max_parallel", "max_parallel_resolved", "worktree_root", "prepare", "lease_seconds", "allocation"],
		"parallel",
	);
	if (
		record.max_parallel !== "bank" &&
		(typeof record.max_parallel !== "number" ||
			!Number.isSafeInteger(record.max_parallel) ||
			record.max_parallel <= 0)
	)
		throw new Error("parallel.max_parallel is invalid");
	if (record.prepare !== null && typeof record.prepare !== "string") throw new Error("parallel.prepare is invalid");
	const allocation = asRecord(record.allocation, "parallel.allocation");
	exactKeys(allocation, ["window", "min_per_role", "plateau_k"], "parallel.allocation");
	return {
		max_parallel: record.max_parallel,
		max_parallel_resolved: positiveInteger(record.max_parallel_resolved, "parallel.max_parallel_resolved"),
		worktree_root: stringValue(record.worktree_root, "parallel.worktree_root"),
		prepare: record.prepare,
		lease_seconds: positiveInteger(record.lease_seconds, "parallel.lease_seconds"),
		allocation: {
			window: positiveInteger(allocation.window, "parallel.allocation.window"),
			min_per_role: positiveInteger(allocation.min_per_role, "parallel.allocation.min_per_role"),
			plateau_k: positiveInteger(allocation.plateau_k, "parallel.allocation.plateau_k"),
		},
	};
}

/** Parse and validate one exact v2 run.json record. */
export function parseV2Run(value: unknown): V2Run {
	const record = asRecord(value, "v2 run");
	exactKeys(record, V2_RUN_KEYS, "v2 run");
	if (record.schema_version !== V2_SCHEMA_VERSION) throw new Error("v2 run schema_version must be 2");
	if (!Array.isArray(record.scope) || record.scope.length === 0) throw new Error("v2 run scope must be non-empty");
	if (record.guard !== null && (typeof record.guard !== "object" || Array.isArray(record.guard)))
		throw new Error("v2 run guard is invalid");
	if (
		record.max_candidates !== null &&
		(typeof record.max_candidates !== "number" ||
			!Number.isSafeInteger(record.max_candidates) ||
			record.max_candidates <= 0)
	)
		throw new Error("v2 run max_candidates is invalid");
	return {
		schema_version: V2_SCHEMA_VERSION,
		run_id: stringValue(record.run_id, "v2 run.run_id"),
		created_at: stringValue(record.created_at, "v2 run.created_at"),
		repo: stringValue(record.repo, "v2 run.repo"),
		branch: stringValue(record.branch, "v2 run.branch"),
		goal: stringValue(record.goal, "v2 run.goal"),
		scope: stringArray(record.scope, "v2 run.scope"),
		metric: parseMetric(record.metric),
		guard: record.guard as V2Guard | null,
		target: finiteNumber(record.target, "v2 run.target"),
		max_candidates: record.max_candidates,
		timeout_seconds: positiveInteger(record.timeout_seconds, "v2 run.timeout_seconds"),
		docs: parseDocs(record.docs),
		parallel: parseParallel(record.parallel),
	};
}

function parseCandidateGrant(value: unknown): V2CandidateGrant {
	const record = asRecord(value, "candidate grant");
	const kind = record.kind;
	if (kind !== "cores" && kind !== "agents" && kind !== "node") throw new Error("candidate grant kind is invalid");
	const allowed =
		kind === "cores"
			? ["source_id", "kind", "cores", "label"]
			: kind === "agents"
				? ["source_id", "kind", "slots", "label"]
				: ["source_id", "kind", "capacity", "label"];
	exactKeys(record, allowed, "candidate grant");
	const capacity = kind === "cores" ? record.cores : kind === "agents" ? record.slots : record.capacity;
	positiveInteger(capacity, `candidate grant ${kind}`);
	return {
		source_id: stringValue(record.source_id, "candidate grant.source_id"),
		kind,
		[kind === "cores" ? "cores" : kind === "agents" ? "slots" : "capacity"]: capacity,
		label: stringValue(record.label, "candidate grant.label"),
	} as V2CandidateGrant;
}

function parseEvent(value: unknown): V2Event {
	const record = asRecord(value, "v2 event");
	const common = ["schema_version", "run_id", "seq", "time", "event"] as const;
	if (record.schema_version !== V2_SCHEMA_VERSION) throw new Error("v2 event schema_version must be 2");
	const event = record.event;
	const keysByEvent: Record<string, readonly string[]> = {
		baseline: [...common, "head", "metric", "verify_log", "guard_log"],
		candidate_started: [
			...common,
			"candidate",
			"base_commit",
			"base_metric",
			"slot",
			"role",
			"role_source",
			"grant",
			"branch",
			"lease_expires_at",
			"goal_sha256",
			"decisions_sha256",
		],
		candidate_resolved: [
			...common,
			"candidate",
			"outcome",
			"reason",
			"description",
			"trial_metric",
			"retained_metric",
			"trial_commit",
			"trial_branch",
			"head",
			"guard",
			"verify_log",
			"guard_log",
		],
		complete: [...common, "reason", "head", "metric", "unresolved_candidates"],
		blocked: [...common, "reason", "head", "metric", "unresolved_candidates"],
		error: [...common, "reason", "head", "metric", "trial_commit", "log", "unresolved_candidates"],
		stopped: [...common, "reason", "head", "metric", "unresolved_candidates"],
	};
	if (typeof event !== "string" || keysByEvent[event] === undefined)
		throw new Error(`unknown v2 event ${String(event)}`);
	exactKeys(record, keysByEvent[event], `v2 ${event} event`);
	stringValue(record.run_id, "v2 event.run_id");
	nonNegativeInteger(record.seq, "v2 event.seq");
	stringValue(record.time, "v2 event.time");
	if (event === "baseline") {
		return {
			...record,
			schema_version: V2_SCHEMA_VERSION,
			event,
			run_id: record.run_id as string,
			seq: record.seq as number,
			time: record.time as string,
			head: stringValue(record.head, "baseline.head"),
			metric: finiteNumber(record.metric, "baseline.metric"),
			verify_log: stringValue(record.verify_log, "baseline.verify_log"),
			guard_log: record.guard_log === null ? null : stringValue(record.guard_log, "baseline.guard_log"),
		} as V2BaselineEvent;
	}
	if (event === "candidate_started") {
		if (record.role !== "exploit" && record.role !== "explore") throw new Error("candidate_started role is invalid");
		return {
			...record,
			schema_version: V2_SCHEMA_VERSION,
			event,
			run_id: record.run_id as string,
			seq: record.seq as number,
			time: record.time as string,
			candidate: positiveInteger(record.candidate, "candidate_started.candidate"),
			base_commit: stringValue(record.base_commit, "candidate_started.base_commit"),
			base_metric: finiteNumber(record.base_metric, "candidate_started.base_metric"),
			slot: nonNegativeInteger(record.slot, "candidate_started.slot"),
			role: record.role,
			role_source: stringValue(record.role_source, "candidate_started.role_source"),
			grant: parseCandidateGrant(record.grant),
			branch: stringValue(record.branch, "candidate_started.branch"),
			lease_expires_at: finiteNumber(record.lease_expires_at, "candidate_started.lease_expires_at"),
			goal_sha256: stringValue(record.goal_sha256, "candidate_started.goal_sha256"),
			decisions_sha256: stringValue(record.decisions_sha256, "candidate_started.decisions_sha256"),
		} as V2CandidateStartedEvent;
	}
	if (event === "candidate_resolved") {
		if (!["admitted", "discarded", "failed", "abandoned", "reaped"].includes(String(record.outcome)))
			throw new Error("candidate_resolved outcome is invalid");
		if (!["pass", "fail", "not_run"].includes(String(record.guard)))
			throw new Error("candidate_resolved guard is invalid");
		return {
			...record,
			schema_version: V2_SCHEMA_VERSION,
			event,
			run_id: record.run_id as string,
			seq: record.seq as number,
			time: record.time as string,
			candidate: positiveInteger(record.candidate, "candidate_resolved.candidate"),
			outcome: record.outcome,
			reason: stringValue(record.reason, "candidate_resolved.reason"),
			description: stringValue(record.description, "candidate_resolved.description"),
			trial_metric:
				record.trial_metric === null ? null : finiteNumber(record.trial_metric, "candidate_resolved.trial_metric"),
			retained_metric:
				record.retained_metric === null
					? null
					: finiteNumber(record.retained_metric, "candidate_resolved.retained_metric"),
			trial_commit:
				record.trial_commit === null ? null : stringValue(record.trial_commit, "candidate_resolved.trial_commit"),
			trial_branch:
				record.trial_branch === null ? null : stringValue(record.trial_branch, "candidate_resolved.trial_branch"),
			head: stringValue(record.head, "candidate_resolved.head"),
			guard: record.guard,
			verify_log: stringValue(record.verify_log, "candidate_resolved.verify_log"),
			guard_log: record.guard_log === null ? null : stringValue(record.guard_log, "candidate_resolved.guard_log"),
		} as V2CandidateResolvedEvent;
	}
	if (event === "error") {
		return {
			...record,
			schema_version: V2_SCHEMA_VERSION,
			event,
			run_id: record.run_id as string,
			seq: record.seq as number,
			time: record.time as string,
			reason: stringValue(record.reason, "error.reason"),
			head: stringValue(record.head, "error.head"),
			metric: finiteNumber(record.metric, "error.metric"),
			trial_commit: record.trial_commit === null ? null : stringValue(record.trial_commit, "error.trial_commit"),
			log: stringValue(record.log, "error.log"),
			unresolved_candidates: parseCandidateNumbers(record.unresolved_candidates, "error.unresolved_candidates"),
		} as V2ErrorEvent;
	}
	if (event === "complete" || event === "blocked" || event === "stopped") {
		return {
			...record,
			schema_version: V2_SCHEMA_VERSION,
			event,
			run_id: record.run_id as string,
			seq: record.seq as number,
			time: record.time as string,
			reason: stringValue(record.reason, `${event}.reason`),
			head: stringValue(record.head, `${event}.head`),
			metric: finiteNumber(record.metric, `${event}.metric`),
			unresolved_candidates: parseCandidateNumbers(record.unresolved_candidates, `${event}.unresolved_candidates`),
		} as V2CompleteEvent | V2BlockedEvent | V2StoppedEvent;
	}
	throw new Error(`unsupported v2 event ${event}`);
}

function parseCandidateNumbers(value: unknown, label: string): readonly number[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry, index) => positiveInteger(entry, `${label}[${index}]`));
}

/** Parse JSONL v2 events, retaining only validated and contiguous records. */
export function parseV2Events(text: string): readonly V2Event[] {
	const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
	const events = lines.map((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error) {
			throw new Error(`v2 event line ${index + 1} is not JSON: ${String(error)}`);
		}
		return parseEvent(value);
	});
	const runId = events[0]?.run_id;
	events.forEach((event, index) => {
		if (event.seq !== index) throw new Error(`v2 event sequence ${String(event.seq)} is not ${index}`);
		if (runId !== undefined && event.run_id !== runId) throw new Error("v2 events contain multiple run IDs");
	});
	return events;
}

export type AutoResearchMetricDirection = "lower" | "higher";

export interface AutoResearchMetricRegistration {
	metricId: string;
	name: string;
	direction: AutoResearchMetricDirection;
	target: number;
	tolerance: number;
}

export interface AutoResearchEvaluatorRegistration {
	evaluatorDigest: string;
	parserDigest: string;
	commandDigest: string;
}

/** Immutable host-owned command and visible-input binding for one run. */
export interface AutoResearchCommandInputBinding {
	commandDigest: string;
	inputDigests: readonly string[];
	bindingDigest: string;
}

export interface AutoResearchSeedRegistration {
	seedId: string;
	seedDigest: string;
}

export type AutoResearchFixturePartition = "train" | "eval" | "holdout" | "adversarial";

export interface AutoResearchFixtureRegistration {
	fixtureId: string;
	partition: AutoResearchFixturePartition;
	inputDigest: string;
	manifestDigest: string;
	hidden: boolean;
}

export interface AutoResearchGuardRegistration {
	guardDigest: string;
}

export interface AutoResearchHostOnlyHoldoutHandle {
	handleId: string;
	manifestDigest: string;
	caseCount: number;
	owner: "host";
	hidden: true;
	opaque: true;
	hostResolverOnly: true;
	bytesAccessibleToProposer: false;
	bytesAccessibleToWorker: false;
}

export type AutoResearchHiddenHoldoutHandle = AutoResearchHostOnlyHoldoutHandle;

/** Host-issued resolver context; no worker or proposer receives holdout bytes. */
export interface AutoResearchHoldoutResolverBinding {
	contextId: string;
	workflowId: string;
	registrationDigest: string;
	handleId: string;
	manifestDigest: string;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	authenticated: true;
	returnsEvidenceOnly: true;
	returnsBytes: false;
	resolverDigest: string;
}

/** Host-verified decision context used to bind a registration lock to one workflow state. */
export interface AutoResearchDecisionResolution {
	ref: WorkflowDecisionRef;
	workflowId: string;
	registrationDigest: string;
	stateDigest: string;
	headDigest: string;
	epochRef: WorkflowEpochRef;
	disposition: "authorized";
	authority: readonly string[];
	fresh: true;
	revoked: false;
	receipt: WorkflowVerifiedHostReceipt;
	resolutionDigest: string;
}

export interface AutoResearchDecisionResolutionRequest {
	workflowId: string;
	registrationDigest: string;
	registration: AutoResearchExperimentRegistration;
	ref: WorkflowDecisionRef;
}

export interface AutoResearchExperimentRegistration {
	runId: string;
	workflowId: string;
	revisionResolution: WorkflowRevisionResolution;
	metric: AutoResearchMetricRegistration;
	evaluator: AutoResearchEvaluatorRegistration;
	commandInputBinding: AutoResearchCommandInputBinding;
	seed: AutoResearchSeedRegistration;
	fixtures: readonly AutoResearchFixtureRegistration[];
	guard: AutoResearchGuardRegistration | null;
	requiredSampleSize: number;
	maxCandidates: number;
	maxVariance: number;
	maxCostMicrounits: number;
	maxLatencyMilliseconds: number;
	resourceCeiling: WorkflowResourceVector;
	hiddenHoldout: AutoResearchHostOnlyHoldoutHandle | null;
}

export type AutoResearchObservationPhase =
	| "exploration"
	| "holdout"
	| "canary"
	| "independent_review"
	| "promotion"
	| "completion";
export type AutoResearchObservationStatus = "complete" | "partial" | "crashed";

/** Worker input is deliberately limited to opaque result references. */
export interface AutoResearchRawObservation {
	observationId: string;
	candidateId: string;
	attemptId: string;
	rawResultRefs: readonly WorkflowArtifactRef[];
}

export interface AutoResearchObservation {
	source: "host";
	observationId: string;
	candidateId: string;
	attemptId: string;
	phase: AutoResearchObservationPhase;
	status: AutoResearchObservationStatus;
	commandInputBinding: AutoResearchCommandInputBinding;
	metricDirection: AutoResearchMetricDirection;
	metricTarget: number;
	metricTolerance: number;
	sampleCount: number;
	metricValue: number;
	baselineMetricValue: number;
	variance: number;
	costMicrounits: number;
	latencyMilliseconds: number;
	resourceUsage: WorkflowResourceVector;
	evaluatorDigest: string;
	parserDigest: string;
	guardDigest: string | null;
	seedDigest: string;
	fixtureManifestDigest: string;
	trainInputDigest: string;
	evalInputDigest: string;
	heldOutInputDigest: string | null;
	proxySignals: readonly string[];
	hiddenMetricValue: number | null;
	adversarialMetricValue: number | null;
	candidateClaimedCompletion: boolean;
	candidateClaimedPromotion: boolean;
	claimedCompletion?: boolean;
	claimedPromotion?: boolean;
	measurementDigest: string;
	rawResultRefsDigest: string;
}

export interface AutoResearchCandidateRequest {
	candidateId: string;
	attemptId: string;
	changeDigest: string;
	baseRevisionDigest: string;
	resourceRequest: WorkflowResourceVector;
	claimedCompletion: boolean;
	claimedPromotion: boolean;
}

export interface AutoResearchTaskSubmission extends AutoResearchCandidateRequest {
	runId: string;
	workflowId: string;
	registrationDigest: string;
	revisionResolution: WorkflowRevisionResolution;
	commandInputBinding: AutoResearchCommandInputBinding;
}

export interface AutoResearchTaskReceipt {
	taskId: string;
	candidateId: string;
	attemptId: string;
	changeDigest: string;
	taskDigest: string;
}

export interface AutoResearchExecutionState {
	status: "pending" | "completed";
	observationId: string;
	candidateId: string;
	attemptId: string;
	candidateBindingDigest: string;
	executionDigest: string;
	rawResultRefs: readonly WorkflowArtifactRef[];
}

export interface AutoResearchEvidenceSubmission {
	runId: string;
	candidateId: string;
	attemptId: string;
	observationId: string;
	outcome: "accepted" | "rejected" | "inconclusive";
	reason: string | null;
	observation: AutoResearchObservation;
}

export interface AutoResearchDecisionSubmission {
	runId: string;
	workflowId: string;
	registrationDigest: string;
	revisionResolution: WorkflowRevisionResolution;
	kind: "registration_lock";
}

export interface AutoResearchHoldoutSubmission {
	runId: string;
	registrationDigest: string;
	handle: AutoResearchHostOnlyHoldoutHandle;
}

export interface AutoResearchHoldoutEvidence {
	handleId: string;
	manifestDigest: string;
	resolverContext: AutoResearchHoldoutResolverBinding;
	evidenceRefs: readonly WorkflowArtifactRef[];
	adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
	evidenceProofs: readonly AutoResearchEvidenceProof[];
	adversarialEvidenceProofs: readonly AutoResearchEvidenceProof[];
	bytesReturned: false;
}

export interface AutoResearchEvidenceProof {
	ref: WorkflowArtifactRef;
	workflowId: string;
	registrationDigest: string;
	kind: "observation" | "holdout" | "adversarial";
	authenticated: true;
	fresh: true;
	revoked: false;
	proofDigest: string;
}

/** Host-derived measurement; workers never provide sample or variance authority. */
export interface AutoResearchHostMeasurement {
	source: "host";
	measurementDigest: string;
	rawResultRefsDigest: string;
	phase: AutoResearchObservationPhase;
	status: AutoResearchObservationStatus;
	commandInputBinding: AutoResearchCommandInputBinding;
	metricDirection: AutoResearchMetricDirection;
	metricTarget: number;
	metricTolerance: number;
	sampleCount: number;
	metricValue: number;
	baselineMetricValue: number;
	variance: number;
	fixtureManifestDigest: string;
	trainInputDigest: string;
	evalInputDigest: string;
	heldOutInputDigest: string | null;
	evaluatorDigest: string;
	parserDigest: string;
	guardDigest: string | null;
	seedDigest: string;
	proxySignals: readonly string[];
	costMicrounits: number;
	latencyMilliseconds: number;
	resourceUsage: WorkflowResourceVector;
	hiddenMetricValue: number | null;
	adversarialMetricValue: number | null;
	candidateClaimedCompletion: false;
	candidateClaimedPromotion: false;
}

/** One native event recovered from an authenticated workflow journal commit. */
export interface AutoResearchRuntimeRecord {
	readonly event: AutoResearchCommittedEvent;
	readonly payload: WorkflowAutoResearchEventPayload;
	readonly commit: WorkflowJournalCommit<WorkflowAutoResearchEventPayload>;
	readonly artifactRef: WorkflowArtifactRef;
	readonly eventDigest: string;
	/** Present only on the commit call that produced or recovered this record. */
	readonly commitStatus?: "committed" | "already_committed";
}

/** Host binding used to build a workflow-store semantic CAS mutation. */
export interface AutoResearchRuntimeCommitInput {
	readonly event: AutoResearchCommittedEvent;
}

export interface AutoResearchProposalCandidateInput {
	registration: AutoResearchExperimentRegistration;
	registrationDigest: string;
	candidateRequest: AutoResearchCandidateRequest;
	task: AutoResearchTaskReceipt;
	observation: AutoResearchObservation;
	evidenceRefs: readonly WorkflowArtifactRef[];
	revisionResolution: WorkflowRevisionResolution;
}

/**
 * Host adapter boundary. Production implementations must delegate these calls to the
 * workflow runtime store; this module only rebuilds an ephemeral projection from replay.
 */
export interface AutoResearchRuntimePort {
	replay(): Promise<readonly AutoResearchRuntimeRecord[]>;
	commit(input: AutoResearchRuntimeCommitInput): Promise<AutoResearchRuntimeRecord>;
}

export interface AutoResearchHostPorts {
	submitTask(input: AutoResearchTaskSubmission): Promise<AutoResearchTaskReceipt>;
	submitEvidence(input: AutoResearchEvidenceSubmission): Promise<WorkflowArtifactRef>;
	submitDecision(input: AutoResearchDecisionSubmission): Promise<WorkflowDecisionRef>;
	resolveDecision(input: AutoResearchDecisionResolutionRequest): Promise<AutoResearchDecisionResolution>;
	submitProposal(input: AutoResearchProposalCandidateInput): Promise<WorkflowImprovementProposal>;
	submitAcceptedProposal(input: {
		transactionDigest: string;
		evidence: AutoResearchEvidenceSubmission;
		proposal: AutoResearchProposalCandidateInput;
	}): Promise<{
		transactionDigest: string;
		evidenceRef: WorkflowArtifactRef;
		evidenceProof: AutoResearchEvidenceProof;
		proposal: WorkflowImprovementProposal;
	}>;
	submitHoldout?(input: AutoResearchHoldoutSubmission): Promise<AutoResearchHoldoutEvidence>;
	measureObservation(input: AutoResearchRawObservation): Promise<AutoResearchHostMeasurement>;
	runtime: AutoResearchRuntimePort;
}

export type AutoResearchCommittedEvent =
	| {
			kind: "registration_locked";
			registration: AutoResearchExperimentRegistration;
			registrationDigest: string;
			decisionRef: WorkflowDecisionRef;
			decisionResolution?: AutoResearchDecisionResolution;
	  }
	| {
			kind: "holdout_submitted";
			registrationDigest: string;
			handleId?: string;
			manifestDigest?: string;
			resolverContext?: AutoResearchHoldoutResolverBinding;
			evidenceRefs: readonly WorkflowArtifactRef[];
			adversarialEvidenceRefs: readonly WorkflowArtifactRef[];
			evidenceProofs?: readonly AutoResearchEvidenceProof[];
			adversarialEvidenceProofs?: readonly AutoResearchEvidenceProof[];
	  }
	| {
			kind: "candidate_submitted";
			registrationDigest: string;
			commandInputBinding: AutoResearchCommandInputBinding;
			request: AutoResearchCandidateRequest;
			task: AutoResearchTaskReceipt;
			candidateBindingDigest: string;
			semanticDigest?: string;
	  }
	| {
			kind: "candidate_execution_intent";
			registrationDigest: string;
			observationId: string;
			candidateRequest: AutoResearchCandidateRequest;
			task: AutoResearchTaskReceipt;
			candidateBindingDigest: string;
			executionDigest: string;
	  }
	| {
			kind: "candidate_execution_completed";
			registrationDigest: string;
			observationId: string;
			candidateRequest: AutoResearchCandidateRequest;
			task: AutoResearchTaskReceipt;
			candidateBindingDigest: string;
			executionDigest: string;
			rawResultRefs: readonly WorkflowArtifactRef[];
			rawResultRefsDigest: string;
	  }
	| {
			kind: "observation_recorded";
			registrationDigest: string;
			observation: AutoResearchObservation;
			accepted: boolean;
			reason: string | null;
			evidenceRef: WorkflowArtifactRef;
			evidenceProof?: AutoResearchEvidenceProof;
			observationDigest?: string;
			decisionDigest?: string;
	  }
	| {
			kind: "accepted_proposal_intent";
			registrationDigest: string;
			transactionDigest: string;
			evidence: AutoResearchEvidenceSubmission;
			observation: AutoResearchObservation;
			observationDigest: string;
			decisionDigest: string;
			proposal: WorkflowImprovementProposal;
			proposalDigest: string;
	  }
	| {
			kind: "accepted_proposal_committed";
			registrationDigest: string;
			observation: AutoResearchObservation;
			accepted: true;
			reason: null;
			evidenceRef: WorkflowArtifactRef;
			evidenceProof: AutoResearchEvidenceProof;
			observationDigest: string;
			decisionDigest: string;
			proposal: WorkflowImprovementProposal;
			proposalDigest: string;
			proposalObservationDigest: string;
	  }
	| {
			kind: "proposal_emitted";
			registrationDigest: string;
			observationId: string;
			proposal: WorkflowImprovementProposal;
			proposalDigest?: string;
			observationDigest?: string;
	  };

export interface AutoResearchEvaluation {
	accepted: boolean;
	reason: string | null;
	evidenceRefs: readonly WorkflowArtifactRef[];
	proposal: WorkflowImprovementProposal | null;
	proposalOnly: true;
}

export interface AutoResearchEngineSnapshot {
	registrationDigest: string | null;
	locked: boolean;
	candidateIds: readonly string[];
	observationIds: readonly string[];
	proposalIds: readonly string[];
	totalCostMicrounits: number;
	totalLatencyMilliseconds: number;
}
