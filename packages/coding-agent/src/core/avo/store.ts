import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { evaluateAvoCheckpoint } from "./checkpoint.js";
import { deriveAvoEvaluation, evaluateGenericAvoStopGate } from "./evaluator.js";
import {
	AVO_AUTHORITIES,
	AVO_ENVIRONMENTS,
	AVO_EVALUATION_ISSUERS,
	AVO_EVALUATION_STATUSES,
	AVO_HORIZONS,
	AVO_MEMORY_NAMESPACES,
	AVO_STATE_VERSION,
	AVO_VERIFICATION_POLICIES,
	type AvoAdapterStateRef,
	type AvoCandidate,
	type AvoCandidateInput,
	type AvoCycle,
	type AvoCycleInput,
	type AvoEnvironment,
	type AvoEnvironmentSelection,
	type AvoEvaluationInput,
	type AvoEvaluationIssuer,
	type AvoEvaluationReceipt,
	type AvoHorizon,
	type AvoHorizonSelection,
	type AvoMemory,
	type AvoMemoryInput,
	type AvoMemoryReflection,
	type AvoRoutingDecision,
	type AvoRunState,
	type AvoStopGate,
	type AvoSupervisorBinding,
	type AvoSupervisorReview,
	type AvoVerificationPolicy,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function requireIdentifier(value: unknown, label: string): string {
	const identifier = requireString(value, label);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identifier)) {
		throw new Error(`${label} must be a marker-safe identifier`);
	}
	return identifier;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return requireString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return [...new Set(value.map((item) => item.trim()))];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${label} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

function scalarMetrics(value: unknown, label: string): Record<string, number | string | boolean> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const metrics: Record<string, number | string | boolean> = {};
	for (const [key, metric] of Object.entries(value)) {
		if (typeof metric !== "number" && typeof metric !== "string" && typeof metric !== "boolean") {
			throw new Error(`${label}.${key} must be a number, string, or boolean`);
		}
		metrics[key] = metric;
	}
	return metrics;
}

function stableJson(value: unknown): string {
	if (value === undefined) return '"[undefined]"';
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as JsonRecord)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
		.join(",")}}`;
}

function digestPayload(payload: unknown): string {
	return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function defaultRouting(now: string): AvoRoutingDecision {
	return {
		environment: "general",
		horizon: "direct",
		source: "host_auto",
		reasons: ["no task prompt has been routed yet"],
		decidedAt: now,
	};
}

function taskRunId(sessionId: string, index: number): string {
	return `${sessionId}:task-${index}`;
}

function emptyState(sessionId: string, now: string): AvoRunState {
	return {
		schemaVersion: AVO_STATE_VERSION,
		sessionId,
		runId: taskRunId(sessionId, 1),
		taskRuns: [],
		verificationPolicy: "best_effort",
		verificationReasons: ["no task prompt has been routed yet"],
		environmentSelection: "auto",
		horizonSelection: "auto",
		routing: defaultRouting(now),
		status: "active",
		candidates: [],
		evaluations: [],
		cycles: [],
		lineage: [],
		checkpoints: [],
		memories: [],
		memoryReflections: [],
		supervision: [],
		createdAt: now,
		updatedAt: now,
	};
}

function isAvoState(value: unknown): value is AvoRunState {
	if (!isRecord(value) || !isRecord(value.routing)) return false;
	return (
		value.schemaVersion === AVO_STATE_VERSION &&
		typeof value.sessionId === "string" &&
		typeof value.runId === "string" &&
		Array.isArray(value.taskRuns) &&
		AVO_VERIFICATION_POLICIES.includes(value.verificationPolicy as AvoVerificationPolicy) &&
		Array.isArray(value.verificationReasons) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		Array.isArray(value.candidates) &&
		Array.isArray(value.evaluations) &&
		value.evaluations.every(
			(receipt) => isRecord(receipt) && AVO_EVALUATION_ISSUERS.includes(receipt.issuedBy as AvoEvaluationIssuer),
		) &&
		Array.isArray(value.cycles) &&
		Array.isArray(value.lineage) &&
		Array.isArray(value.checkpoints) &&
		Array.isArray(value.memories) &&
		Array.isArray(value.memoryReflections) &&
		Array.isArray(value.supervision) &&
		AVO_ENVIRONMENTS.includes(value.routing.environment as AvoEnvironment) &&
		AVO_HORIZONS.includes(value.routing.horizon as AvoHorizon)
	);
}

function isLegacyAvoState(value: unknown): value is JsonRecord {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.routing)) return false;
	return (
		typeof value.runId === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		Array.isArray(value.candidates) &&
		Array.isArray(value.evaluations) &&
		Array.isArray(value.cycles) &&
		Array.isArray(value.lineage) &&
		Array.isArray(value.checkpoints) &&
		Array.isArray(value.memories) &&
		Array.isArray(value.memoryReflections) &&
		Array.isArray(value.supervision) &&
		AVO_ENVIRONMENTS.includes(value.routing.environment as AvoEnvironment) &&
		AVO_HORIZONS.includes(value.routing.horizon as AvoHorizon)
	);
}

function migrateLegacyAvoState(value: JsonRecord): AvoRunState {
	const environment = (value.routing as AvoRoutingDecision).environment;
	const sessionId = value.runId as string;
	return {
		...(value as unknown as Omit<AvoRunState, "schemaVersion" | "sessionId" | "runId" | "taskRuns">),
		schemaVersion: AVO_STATE_VERSION,
		sessionId,
		runId: taskRunId(sessionId, 1),
		taskRuns: [],
		verificationPolicy: environment === "general" ? "best_effort" : "required",
		verificationReasons: ["migrated from AVO v1; legacy authoritative receipts require fresh host verification"],
		evaluations: (value.evaluations as AvoEvaluationReceipt[]).map((receipt) => ({
			...receipt,
			issuedBy: "legacy_unverified" as const,
		})),
	};
}

function wordSet(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((term) => term.length > 2),
	);
}

function containsSignal(value: string, signal: string): boolean {
	const words = signal.toLowerCase().match(/[a-z0-9]+/g);
	if (!words || words.length === 0) return false;
	return new RegExp(`(?:^|[^a-z0-9])${words.join("[^a-z0-9]+")}(?:$|[^a-z0-9])`, "i").test(value);
}

function matchingSignals(value: string, signals: readonly string[]): string[] {
	return signals.filter((signal) => containsSignal(value, signal));
}

export function inferAvoEnvironment(prompt: string, cwd = ""): { environment: AvoEnvironment; reasons: string[] } {
	const normalized = prompt.toLowerCase();
	const researchSignals = matchingSignals(normalized, [
		"autoresearch",
		"research gap",
		"publication-grade",
		"prior art",
		"literature review",
		"novel research",
		"peer reviewed",
		"research hypothesis",
	]);
	if (researchSignals.length > 0) {
		return { environment: "research", reasons: [`research signals: ${researchSignals.join(", ")}`] };
	}
	const strongCodingSignals = matchingSignals(normalized, [
		"code",
		"coding",
		"repository",
		"git",
		"compile",
		"stack trace",
		"pull request",
		"unit test",
		"integration test",
	]);
	const codingActions = matchingSignals(normalized, ["implement", "fix", "debug", "test", "build", "refactor"]);
	const codingObjects = matchingSignals(normalized, [
		"parser",
		"function",
		"class",
		"module",
		"api",
		"cli",
		"app",
		"application",
		"script",
		"bug",
		"stack trace",
		"repository",
		"software",
		"test suite",
	]);
	const codingSignals = [
		...strongCodingSignals,
		...(codingActions.length > 0 && codingObjects.length > 0 ? [...codingActions, ...codingObjects] : []),
	];
	const artifactSignals = normalized.match(
		/(?:^|[\s`'"(])(?:[\w./-]+\.(?:c|cc|cpp|cs|go|java|js|jsx|kt|php|py|rb|rs|sh|sql|swift|ts|tsx|vue)|package\.json|pyproject\.toml|cargo\.toml)(?:$|[\s`'"),:])/g,
	);
	if (codingSignals.length > 0 || (artifactSignals?.length ?? 0) > 0) {
		return {
			environment: "coding",
			reasons: [
				...(codingSignals.length > 0 ? [`coding signals: ${codingSignals.join(", ")}`] : []),
				...((artifactSignals?.length ?? 0) > 0 ? ["referenced code or repository artifacts"] : []),
			],
		};
	}
	return {
		environment: "general",
		reasons: [
			"no research or coding-specific task signal",
			...(existsSync(join(cwd, ".git")) ? ["Git workspace treated as context only, not a routing decision"] : []),
		],
	};
}

export function inferAvoVerificationPolicy(
	prompt: string,
	environment: AvoEnvironment,
): { policy: AvoVerificationPolicy; reasons: string[] } {
	if (environment === "coding" || environment === "research") {
		return { policy: "required", reasons: [`${environment} work requires host-observed verification`] };
	}
	const normalized = prompt.toLowerCase();
	const subjectiveSignals = matchingSignals(normalized, [
		"write a poem",
		"write a story",
		"brainstorm",
		"suggest names",
		"name ideas",
		"rewrite",
		"rephrase",
		"make this sound",
		"creative",
	]);
	if (subjectiveSignals.length > 0) {
		return {
			policy: "not_applicable",
			reasons: [`subjective task signals: ${subjectiveSignals.join(", ")}`],
		};
	}
	const requiredSignals = matchingSignals(normalized, [
		"verify",
		"check whether",
		"calculate",
		"compute",
		"prove",
		"look up",
		"latest",
		"current",
		"exact",
		"fact check",
	]);
	if (requiredSignals.length > 0) {
		return { policy: "required", reasons: [`verification signals: ${requiredSignals.join(", ")}`] };
	}
	return {
		policy: "best_effort",
		reasons: ["general task permits transparent best-effort evaluation when no external verifier exists"],
	};
}

export function inferAvoHorizon(
	prompt: string,
	environment: AvoEnvironment,
): { horizon: AvoHorizon; reasons: string[] } {
	const normalized = prompt.toLowerCase();
	const longSignals = matchingSignals(normalized, [
		"do not stop",
		"until done",
		"keep going",
		"long-horizon",
		"comprehensive audit",
		"full audit",
		"publication-grade",
		"autoresearch",
		"exhaustive",
	]);
	if (environment === "research" || longSignals.length > 0) {
		return {
			horizon: "long",
			reasons:
				longSignals.length > 0 ? [`long-horizon signals: ${longSignals.join(", ")}`] : ["research environment"],
		};
	}
	const iterativeSignals = matchingSignals(normalized, [
		"fix",
		"debug",
		"implement",
		"investigate",
		"improve",
		"optimize",
		"refactor",
		"audit",
	]);
	if (iterativeSignals.length > 0) {
		return { horizon: "iterative", reasons: [`iterative signals: ${iterativeSignals.join(", ")}`] };
	}
	return { horizon: "direct", reasons: ["single-answer or single-action task"] };
}

export function parseAvoCandidateInput(value: unknown): AvoCandidateInput {
	if (!isRecord(value)) throw new Error("candidate must be an object");
	if (!("payload" in value)) throw new Error("candidate.payload is required");
	return {
		candidateId: value.candidate_id === undefined ? undefined : requireIdentifier(value.candidate_id, "candidate_id"),
		kind: requireIdentifier(value.kind, "candidate.kind"),
		summary: requireString(value.summary, "candidate.summary"),
		payload: value.payload,
		parentCandidateId: optionalString(value.parent_candidate_id, "candidate.parent_candidate_id"),
	};
}

export function parseAvoEvaluationInput(value: unknown): AvoEvaluationInput {
	if (!isRecord(value)) throw new Error("evaluation must be an object");
	return {
		evaluationId:
			value.evaluation_id === undefined ? undefined : requireIdentifier(value.evaluation_id, "evaluation_id"),
		candidateId: requireIdentifier(value.candidate_id, "evaluation.candidate_id"),
		evaluatorId: requireIdentifier(value.evaluator_id, "evaluation.evaluator_id"),
		status: enumValue(value.status, AVO_EVALUATION_STATUSES, "evaluation.status"),
		authority: enumValue(value.authority, AVO_AUTHORITIES, "evaluation.authority"),
		evidenceRefs: stringArray(value.evidence_refs ?? [], "evaluation.evidence_refs"),
		metrics: scalarMetrics(value.metrics ?? {}, "evaluation.metrics"),
	};
}

export function parseAvoCycleInput(value: unknown): AvoCycleInput {
	if (!isRecord(value)) throw new Error("cycle must be an object");
	return {
		candidateId: requireIdentifier(value.candidate_id, "cycle.candidate_id"),
		evaluationIds:
			value.evaluation_ids === undefined ? undefined : stringArray(value.evaluation_ids, "cycle.evaluation_ids"),
		failureSignature: optionalString(value.failure_signature, "cycle.failure_signature"),
		trajectoryFingerprint: optionalString(value.trajectory_fingerprint, "cycle.trajectory_fingerprint"),
	};
}

export function parseAvoMemoryInput(value: unknown): AvoMemoryInput {
	if (!isRecord(value)) throw new Error("memory must be an object");
	if (
		typeof value.importance !== "number" ||
		!Number.isFinite(value.importance) ||
		value.importance < 0 ||
		value.importance > 10
	) {
		throw new Error("memory.importance must be a number from 0 to 10");
	}
	return {
		memoryId: value.memory_id === undefined ? undefined : requireIdentifier(value.memory_id, "memory_id"),
		namespace: enumValue(value.namespace, AVO_MEMORY_NAMESPACES, "memory.namespace"),
		type: requireIdentifier(value.type, "memory.type"),
		title: requireString(value.title, "memory.title"),
		content: requireString(value.content, "memory.content"),
		tags: value.tags === undefined ? [] : stringArray(value.tags, "memory.tags"),
		importance: value.importance,
		sourceIds: value.source_ids === undefined ? [] : stringArray(value.source_ids, "memory.source_ids"),
	};
}

export class AvoStore {
	private readonly statePath?: string;
	private state: AvoRunState;
	private loadError?: string;

	constructor(
		artifactDir?: string,
		sessionId = artifactDir ? basename(artifactDir) : `avo-${randomUUID()}`,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly cwd = process.cwd(),
	) {
		this.statePath = artifactDir ? join(artifactDir, "avo", "state.json") : undefined;
		this.state = this.load(sessionId);
		if (this.statePath && !existsSync(this.statePath) && !this.loadError) this.save();
	}

	private load(sessionId: string): AvoRunState {
		const fallback = emptyState(sessionId, this.now());
		if (!this.statePath || !existsSync(this.statePath)) return fallback;
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
			if (isAvoState(parsed)) return parsed;
			if (isLegacyAvoState(parsed)) return migrateLegacyAvoState(parsed);
			throw new Error("state schema is invalid or unsupported");
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
			return fallback;
		}
	}

	private assertHealthy(): void {
		if (this.loadError)
			throw new Error(`AVO state could not be loaded; the existing file was preserved: ${this.loadError}`);
	}

	private save(): void {
		this.assertHealthy();
		this.state.updatedAt = this.now();
		if (!this.statePath) return;
		mkdirSync(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
	}

	getState(): AvoRunState {
		this.assertHealthy();
		return structuredClone(this.state);
	}

	getStatePath(): string | undefined {
		return this.statePath;
	}

	initialize(objective: string, prompt = objective): AvoRunState {
		const normalizedObjective = requireString(objective, "objective");
		if (!this.state.objective) {
			this.state.objective = normalizedObjective;
			this.state.lineage.push({
				lineageId: `lineage-${randomUUID()}`,
				kind: "initialized",
				summary: `Initialized AVO objective: ${normalizedObjective}`,
				recordedAt: this.now(),
			});
		}
		this.routePrompt(prompt);
		this.save();
		return this.getState();
	}

	startTask(objective: string, prompt = objective, archiveReason = "previous task passed its stop gate"): AvoRunState {
		const normalizedObjective = requireString(objective, "objective");
		if (this.state.objective) {
			this.state.taskRuns.push({
				runId: this.state.runId,
				objective: this.state.objective,
				verificationPolicy: this.state.verificationPolicy,
				verificationReasons: [...this.state.verificationReasons],
				routing: structuredClone(this.state.routing),
				status: this.state.status,
				candidates: structuredClone(this.state.candidates),
				evaluations: structuredClone(this.state.evaluations),
				cycles: structuredClone(this.state.cycles),
				lineage: structuredClone(this.state.lineage),
				checkpoints: structuredClone(this.state.checkpoints),
				supervision: structuredClone(this.state.supervision),
				adapterStateRef: this.state.adapterStateRef ? structuredClone(this.state.adapterStateRef) : undefined,
				createdAt: this.state.createdAt,
				updatedAt: this.state.updatedAt,
				archivedAt: this.now(),
				archiveReason: requireString(archiveReason, "archive reason"),
			});
		}
		const now = this.now();
		this.state.runId = taskRunId(this.state.sessionId, this.state.taskRuns.length + 1);
		this.state.objective = normalizedObjective;
		this.state.environmentSelection = "auto";
		this.state.routing = defaultRouting(now);
		this.state.status = "active";
		this.state.candidates = [];
		this.state.evaluations = [];
		this.state.cycles = [];
		this.state.lineage = [
			{
				lineageId: `lineage-${randomUUID()}`,
				kind: "initialized",
				summary: `Initialized AVO task run: ${normalizedObjective}`,
				recordedAt: now,
			},
		];
		this.state.checkpoints = [];
		this.state.supervision = [];
		this.state.adapterStateRef = undefined;
		this.state.createdAt = now;
		this.routePrompt(prompt);
		this.save();
		return this.getState();
	}

	routePrompt(prompt: string): AvoRoutingDecision {
		const normalized = requireString(prompt, "prompt");
		const inferredEnvironment = inferAvoEnvironment(normalized, this.cwd);
		const hasTrajectory = this.state.candidates.length > 0 || this.state.cycles.length > 0;
		const environment =
			this.state.environmentSelection === "auto"
				? hasTrajectory
					? this.state.routing.environment
					: inferredEnvironment.environment
				: this.state.environmentSelection;
		const inferredHorizon = inferAvoHorizon(normalized, environment);
		const inferredVerification = inferAvoVerificationPolicy(normalized, environment);
		const horizonRank: Record<AvoHorizon, number> = { direct: 0, iterative: 1, long: 2 };
		const horizon =
			this.state.horizonSelection === "auto"
				? horizonRank[inferredHorizon.horizon] > horizonRank[this.state.routing.horizon]
					? inferredHorizon.horizon
					: this.state.routing.horizon
				: this.state.horizonSelection;
		const decision: AvoRoutingDecision = {
			environment,
			horizon,
			source:
				this.state.environmentSelection === "auto" && this.state.horizonSelection === "auto" ? "host_auto" : "user",
			reasons: [
				...(this.state.environmentSelection === "auto"
					? hasTrajectory
						? [`preserved active ${environment} trajectory`]
						: inferredEnvironment.reasons
					: [`environment overridden to ${environment}`]),
				...(this.state.horizonSelection === "auto"
					? inferredHorizon.reasons
					: [`horizon overridden to ${horizon}`]),
			],
			decidedAt: this.now(),
		};
		this.state.routing = decision;
		this.state.verificationPolicy = inferredVerification.policy;
		this.state.verificationReasons = inferredVerification.reasons;
		this.save();
		return structuredClone(decision);
	}

	setEnvironment(selection: AvoEnvironmentSelection, source: "model" | "user" = "user"): AvoRunState {
		if (selection !== "auto" && !AVO_ENVIRONMENTS.includes(selection)) throw new Error("invalid AVO environment");
		this.state.environmentSelection = selection;
		if (selection !== "auto") {
			this.state.routing.environment = selection;
			if (selection !== "general") {
				this.state.verificationPolicy = "required";
				this.state.verificationReasons = [`${selection} work requires host-observed verification`];
			}
		}
		this.recordRoutingChange(`Environment selection changed to ${selection}`, source);
		return this.getState();
	}

	setHorizon(selection: AvoHorizonSelection, source: "model" | "user" = "user"): AvoRunState {
		if (selection !== "auto" && !AVO_HORIZONS.includes(selection)) throw new Error("invalid AVO horizon");
		this.state.horizonSelection = selection;
		if (selection !== "auto") this.state.routing.horizon = selection;
		this.recordRoutingChange(`Horizon selection changed to ${selection}`, source);
		return this.getState();
	}

	private recordRoutingChange(summary: string, source: "model" | "user"): void {
		this.state.routing = { ...this.state.routing, source, decidedAt: this.now(), reasons: [summary] };
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "routing_changed",
			summary,
			recordedAt: this.now(),
		});
		this.save();
	}

	recordCandidate(input: AvoCandidateInput): AvoCandidate {
		const candidateId = input.candidateId ?? `candidate-${randomUUID()}`;
		if (this.state.candidates.some((candidate) => candidate.candidateId === candidateId)) {
			throw new Error(`candidate ${candidateId} already exists`);
		}
		if (
			input.parentCandidateId &&
			!this.state.candidates.some((candidate) => candidate.candidateId === input.parentCandidateId)
		) {
			throw new Error(`candidate parent ${input.parentCandidateId} does not exist`);
		}
		if (input.workspaceDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.workspaceDigest)) {
			throw new Error("candidate workspace digest must be a SHA-256 digest");
		}
		const candidate: AvoCandidate = {
			candidateId: requireIdentifier(candidateId, "candidate_id"),
			kind: requireIdentifier(input.kind, "candidate.kind"),
			summary: requireString(input.summary, "candidate.summary"),
			payloadDigest: digestPayload(input.payload),
			workspaceDigest: input.workspaceDigest,
			workspaceHead: input.workspaceHead,
			workspaceMode: input.workspaceMode,
			parentCandidateId: input.parentCandidateId,
			createdAt: this.now(),
		};
		this.state.candidates.push(candidate);
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "candidate_recorded",
			summary: candidate.summary,
			referenceId: candidate.candidateId,
			recordedAt: candidate.createdAt,
		});
		this.save();
		return structuredClone(candidate);
	}

	recordEvaluation(
		input: AvoEvaluationInput,
		issuedBy: Exclude<AvoEvaluationIssuer, "legacy_unverified">,
	): AvoEvaluationReceipt {
		if (!this.state.candidates.some((candidate) => candidate.candidateId === input.candidateId)) {
			throw new Error(`evaluation references unknown candidate ${input.candidateId}`);
		}
		if (issuedBy === "model" && input.authority !== "model_opinion") {
			throw new Error("model-issued evaluations must use authority=model_opinion");
		}
		if (input.authority !== "model_opinion" && issuedBy !== "host") {
			throw new Error("authoritative evaluations must be issued from host-observed evidence");
		}
		if (input.authority !== "model_opinion" && input.evidenceRefs.length === 0) {
			throw new Error("host, environment, and external evaluations require evidence_refs");
		}
		const evaluationId = input.evaluationId ?? `evaluation-${randomUUID()}`;
		const existingEvaluationIndex = this.state.evaluations.findIndex(
			(evaluation) => evaluation.evaluationId === evaluationId,
		);
		if (
			existingEvaluationIndex >= 0 &&
			this.state.evaluations[existingEvaluationIndex]?.issuedBy === "legacy_unverified" &&
			issuedBy === "host"
		) {
			this.state.evaluations.splice(existingEvaluationIndex, 1);
		} else if (existingEvaluationIndex >= 0) {
			throw new Error(`evaluation ${evaluationId} already exists`);
		}
		const receipt: AvoEvaluationReceipt = {
			evaluationId: requireIdentifier(evaluationId, "evaluation_id"),
			candidateId: input.candidateId,
			evaluatorId: requireIdentifier(input.evaluatorId, "evaluation.evaluator_id"),
			status: input.status,
			authority: input.authority,
			issuedBy,
			evidenceRefs: [...new Set(input.evidenceRefs)],
			metrics: structuredClone(input.metrics),
			createdAt: this.now(),
		};
		this.state.evaluations.push(receipt);
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "evaluation_recorded",
			summary: `${receipt.evaluatorId}: ${receipt.status} (${receipt.authority})`,
			referenceId: receipt.evaluationId,
			recordedAt: receipt.createdAt,
		});
		this.save();
		return structuredClone(receipt);
	}

	completeCycle(
		input: AvoCycleInput,
		deriveEvaluation: (
			candidate: AvoCandidate,
			receipts: readonly AvoEvaluationReceipt[],
		) => { status: "pass" | "fail" | "revise" | "inconclusive" } = (_candidate, receipts) =>
			deriveAvoEvaluation(receipts),
	): { cycle: AvoCycle; checkpoint: ReturnType<typeof evaluateAvoCheckpoint> } {
		const candidate = this.state.candidates.find((item) => item.candidateId === input.candidateId);
		if (!candidate) throw new Error(`cycle references unknown candidate ${input.candidateId}`);
		if (this.state.cycles.some((cycle) => cycle.candidateId === input.candidateId)) {
			throw new Error(`candidate ${input.candidateId} already has a completed cycle`);
		}
		const candidateEvaluations = this.state.evaluations.filter(
			(evaluation) => evaluation.candidateId === input.candidateId,
		);
		const evaluationIds = input.evaluationIds ?? candidateEvaluations.map((evaluation) => evaluation.evaluationId);
		for (const evaluationId of evaluationIds) {
			if (!candidateEvaluations.some((evaluation) => evaluation.evaluationId === evaluationId)) {
				throw new Error(`cycle evaluation ${evaluationId} is not bound to candidate ${input.candidateId}`);
			}
		}
		const derived = deriveEvaluation(
			candidate,
			candidateEvaluations.filter((evaluation) => evaluationIds.includes(evaluation.evaluationId)),
		);
		const outcome =
			derived.status === "pass"
				? "accepted"
				: derived.status === "fail"
					? "rejected"
					: derived.status === "revise"
						? "revised"
						: "inconclusive";
		const completedAt = this.now();
		const cycle: AvoCycle = {
			cycleId: `cycle-${randomUUID()}`,
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds,
			outcome,
			failureSignature: input.failureSignature,
			trajectoryFingerprint: input.trajectoryFingerprint,
			completedAt,
		};
		this.state.cycles.push(cycle);
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "cycle_completed",
			summary: `${candidate.candidateId}: ${outcome}`,
			referenceId: cycle.cycleId,
			recordedAt: completedAt,
		});
		if (outcome === "accepted") {
			this.state.lineage.push({
				lineageId: `lineage-${randomUUID()}`,
				kind: "candidate_accepted",
				summary: candidate.summary,
				referenceId: candidate.candidateId,
				recordedAt: completedAt,
			});
		}
		const checkpoint = evaluateAvoCheckpoint(this.state.cycles, completedAt);
		this.state.checkpoints.push(checkpoint);
		this.applyAutomaticEscalation(cycle, checkpoint);
		this.save();
		return { cycle: structuredClone(cycle), checkpoint: structuredClone(checkpoint) };
	}

	private applyAutomaticEscalation(cycle: AvoCycle, checkpoint: ReturnType<typeof evaluateAvoCheckpoint>): void {
		if (this.state.horizonSelection !== "auto" || cycle.outcome === "accepted") return;
		const previous = this.state.routing.horizon;
		const next =
			previous === "direct"
				? "iterative"
				: previous === "iterative" && checkpoint.interventionNeeded
					? "long"
					: previous;
		if (next === previous) return;
		this.state.routing = {
			...this.state.routing,
			horizon: next,
			source: "host_auto",
			reasons: [`escalated after ${cycle.outcome} cycle ${cycle.cycleId}`],
			decidedAt: this.now(),
		};
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "horizon_escalated",
			summary: `Escalated horizon from ${previous} to ${next}`,
			referenceId: cycle.cycleId,
			recordedAt: this.now(),
		});
	}

	setSupervisor(binding: Omit<AvoSupervisorBinding, "boundAt">): AvoSupervisorBinding {
		this.state.supervisor = { ...binding, boundAt: this.now() };
		this.save();
		return structuredClone(this.state.supervisor);
	}

	recordSupervision(review: Omit<AvoSupervisorReview, "reviewId" | "recordedAt">): AvoSupervisorReview {
		if (!this.state.cycles.some((cycle) => cycle.cycleId === review.cycleId)) {
			throw new Error(`supervision references unknown cycle ${review.cycleId}`);
		}
		if (this.state.supervision.some((item) => item.cycleId === review.cycleId && item.source === review.source)) {
			throw new Error(`cycle ${review.cycleId} already has ${review.source} supervision`);
		}
		const recorded: AvoSupervisorReview = {
			...review,
			reviewId: `supervision-${randomUUID()}`,
			recordedAt: this.now(),
		};
		this.state.supervision.push(recorded);
		if (recorded.status === "intervene") {
			this.state.lineage.push({
				lineageId: `lineage-${randomUUID()}`,
				kind: "supervisor_intervention",
				summary: recorded.reason,
				referenceId: recorded.reviewId,
				recordedAt: recorded.recordedAt,
			});
		}
		this.save();
		return structuredClone(recorded);
	}

	remember(input: AvoMemoryInput): AvoMemory {
		const memoryId = input.memoryId ?? `memory-${randomUUID()}`;
		if (this.state.memories.some((memory) => memory.memoryId === memoryId)) {
			throw new Error(`memory ${memoryId} already exists`);
		}
		const sourceIds = input.sourceIds ?? [];
		if (input.namespace === "shared") {
			const runs = [
				...this.state.taskRuns.map((run) => ({
					environment: run.routing.environment,
					candidates: run.candidates,
					evaluations: run.evaluations,
					cycles: run.cycles,
					lineage: run.lineage,
				})),
				{
					environment: this.state.routing.environment,
					candidates: this.state.candidates,
					evaluations: this.state.evaluations,
					cycles: this.state.cycles,
					lineage: this.state.lineage,
				},
			];
			const references = new Map<AvoEnvironment, Set<string>>(
				AVO_ENVIRONMENTS.map((environment) => [environment, new Set<string>()]),
			);
			for (const run of runs) {
				const acceptedCandidateIds = new Set(
					run.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
				);
				const accepted = references.get(run.environment)!;
				for (const candidateId of acceptedCandidateIds) accepted.add(candidateId);
				for (const cycle of run.cycles) if (cycle.outcome === "accepted") accepted.add(cycle.cycleId);
				for (const evaluation of run.evaluations) {
					if (
						evaluation.issuedBy === "host" &&
						evaluation.authority !== "model_opinion" &&
						evaluation.status === "pass" &&
						acceptedCandidateIds.has(evaluation.candidateId)
					) {
						accepted.add(evaluation.evaluationId);
					}
				}
				for (const lineage of run.lineage) {
					if (lineage.kind === "candidate_accepted" || lineage.kind === "adapter_progress") {
						accepted.add(lineage.lineageId);
						if (lineage.referenceId) accepted.add(lineage.referenceId);
					}
				}
			}
			const qualifiedEnvironments = new Set<AvoEnvironment>();
			for (const sourceId of sourceIds) {
				const match = /^(general|coding|research):(.+)$/.exec(sourceId);
				if (!match) throw new Error(`shared memory source ${sourceId} is not environment-qualified`);
				const environment = match[1] as AvoEnvironment;
				const referenceId = match[2]!;
				if (!references.get(environment)?.has(referenceId)) {
					throw new Error(`shared memory source ${sourceId} does not resolve to accepted host-owned lineage`);
				}
				qualifiedEnvironments.add(environment);
			}
			if (sourceIds.length < 2 || qualifiedEnvironments.size < 2) {
				throw new Error("shared memories require at least two resolved source_ids from distinct environments");
			}
		}
		const memory: AvoMemory = {
			memoryId,
			namespace: input.namespace,
			type: input.type,
			title: input.title,
			content: input.content,
			tags: input.tags ?? [],
			importance: input.importance,
			sourceIds,
			createdAt: this.now(),
		};
		this.state.memories.push(memory);
		this.save();
		return structuredClone(memory);
	}

	recall(query: string, namespaces: readonly AvoMemory["namespace"][], limit = 8): AvoMemory[] {
		const terms = wordSet(requireString(query, "query"));
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50");
		const allowed = new Set(namespaces);
		return this.state.memories
			.filter((memory) => !memory.invalidatedAt && allowed.has(memory.namespace))
			.map((memory) => {
				const memoryTerms = wordSet(`${memory.title} ${memory.content} ${memory.tags.join(" ")}`);
				let overlap = 0;
				for (const term of terms) if (memoryTerms.has(term)) overlap += 1;
				return { memory, score: terms.size === 0 ? 0 : overlap / terms.size + memory.importance / 100 };
			})
			.filter((item) => item.score > 0.05)
			.sort((left, right) => right.score - left.score)
			.slice(0, limit)
			.map((item) => structuredClone(item.memory));
	}

	recordMemoryReflection(input: Omit<AvoMemoryReflection, "reflectionId" | "recordedAt">): AvoMemoryReflection {
		for (const memoryId of input.archivedMemoryIds) {
			const memory = this.state.memories.find((item) => item.memoryId === memoryId);
			if (memory && !memory.invalidatedAt) memory.invalidatedAt = this.now();
		}
		const reflection: AvoMemoryReflection = {
			...input,
			reflectionId: `reflection-${randomUUID()}`,
			recordedAt: this.now(),
		};
		this.state.memoryReflections.push(reflection);
		this.save();
		return structuredClone(reflection);
	}

	recordAdapterProgress(summary: string, referenceId: string): void {
		const normalizedReference = requireString(referenceId, "adapter progress reference_id");
		if (
			this.state.lineage.some(
				(entry) => entry.kind === "adapter_progress" && entry.referenceId === normalizedReference,
			)
		) {
			return;
		}
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "adapter_progress",
			summary: requireString(summary, "adapter progress summary"),
			referenceId: normalizedReference,
			recordedAt: this.now(),
		});
		this.save();
	}

	setAdapterStateRef(reference: AvoAdapterStateRef): AvoAdapterStateRef {
		if (reference.adapterId !== this.state.routing.environment) {
			throw new Error("adapter state reference must match the effective environment");
		}
		this.state.adapterStateRef = structuredClone(reference);
		this.save();
		return structuredClone(reference);
	}

	evaluateStopGate(): AvoStopGate {
		return evaluateGenericAvoStopGate(this.state.candidates, this.state.evaluations);
	}

	complete(gate: AvoStopGate = this.evaluateStopGate()): AvoRunState {
		if (!gate.passed) throw new Error(`AVO completion is blocked: ${gate.reasons.join("; ")}`);
		this.state.status = "completed";
		this.state.lineage.push({
			lineageId: `lineage-${randomUUID()}`,
			kind: "completed",
			summary: "Completed after authoritative evaluation passed the final gate",
			recordedAt: this.now(),
		});
		this.save();
		return this.getState();
	}
}
