import { digestObject } from "./contracts.js";

export const WORKFLOW_DECISION_RESOLUTION_MANIFEST_SCHEMA_VERSION = 1 as const;

export type WorkflowDecisionResolutionSource =
	| "signed_user_approval"
	| "durable_goal"
	| "sealed_spec"
	| "invariant"
	| "reversible_default";

export type WorkflowDecisionResolutionConfidence = "high" | "medium" | "low";
export type WorkflowDecisionResolutionReversibility = "reversible" | "irreversible";

export type WorkflowDecisionResolutionExternalEffectClass =
	| "none"
	| "user_visible_intent"
	| "signed_pareto_tradeoff"
	| "provider_or_cloud"
	| "material_spend_or_cloud"
	| "protected_read"
	| "legal_or_safety"
	| "credential_action"
	| "irreversible_external_effect";

export type WorkflowDecisionResolutionStatus = "auto_resolved" | "needs_authority";
export type WorkflowDecisionResolutionEffectAuthorization = "not_required" | "authorized" | "needs_authority";
export type WorkflowDecisionResolutionDesignPolicy = "fail_closed";

export interface WorkflowDecisionResolutionRedTeamChallenge {
	challenge: string;
	outcome: "passed" | "failed";
	evidenceRefs: readonly string[];
}

export interface WorkflowDecisionResolutionReversibleDefaultBasis {
	inScope: boolean;
	noNewCost: boolean;
	safetyPreserved: boolean;
	noExternalAuthority: boolean;
}

export interface WorkflowDecisionResolutionDecisionInput {
	decision: string;
	source: WorkflowDecisionResolutionSource;
	confidence: WorkflowDecisionResolutionConfidence;
	redTeamChallenge: WorkflowDecisionResolutionRedTeamChallenge;
	reversibility: WorkflowDecisionResolutionReversibility;
	externalEffectClass: WorkflowDecisionResolutionExternalEffectClass;
	resolutionRefs: readonly string[];
	evidenceRefs: readonly string[];
	reversibleDefaultBasis?: WorkflowDecisionResolutionReversibleDefaultBasis;
	effectAuthorizationRefs?: readonly string[];
}

export type WorkflowDecisionResolutionQuestionReason = "design_authority_required" | "effect_authorization_required";

export interface WorkflowDecisionResolutionQuestion {
	decision: string;
	reason: WorkflowDecisionResolutionQuestionReason;
	externalEffectClass: WorkflowDecisionResolutionExternalEffectClass;
	prompt: string;
	resolutionRefs: readonly string[];
	evidenceRefs: readonly string[];
	redTeamEvidenceRefs: readonly string[];
}

export type WorkflowDecisionResolutionAvoidedQuestionReason =
	| "already_approved"
	| "hard_invariant"
	| "safe_reversible_default";

export interface WorkflowDecisionResolutionAvoidedQuestion {
	decision: string;
	reason: WorkflowDecisionResolutionAvoidedQuestionReason;
	resolutionRefs: readonly string[];
	evidenceRefs: readonly string[];
	redTeamEvidenceRefs: readonly string[];
}

export interface WorkflowDecisionResolutionDecision extends WorkflowDecisionResolutionDecisionInput {
	resolution: WorkflowDecisionResolutionStatus;
	designSelection: WorkflowDecisionResolutionStatus;
	effectAuthorization: WorkflowDecisionResolutionEffectAuthorization;
}

export interface WorkflowDecisionResolutionApprovalManifest {
	kind: "bounded_approval_manifest";
	bounded: true;
	serial: false;
	questions: readonly WorkflowDecisionResolutionQuestion[];
}

export interface WorkflowDecisionResolutionManifest {
	schemaVersion: typeof WORKFLOW_DECISION_RESOLUTION_MANIFEST_SCHEMA_VERSION;
	workflowId: string | null;
	designPolicy: WorkflowDecisionResolutionDesignPolicy;
	decisions: readonly WorkflowDecisionResolutionDecision[];
	pendingQuestions: readonly WorkflowDecisionResolutionQuestion[];
	approvalManifest: WorkflowDecisionResolutionApprovalManifest;
	questionsAvoided: readonly WorkflowDecisionResolutionAvoidedQuestion[];
	manifestDigest: string;
}

export interface WorkflowDecisionResolutionManifestInput {
	workflowId?: string;
	decisions: readonly WorkflowDecisionResolutionDecisionInput[];
}

export class WorkflowDecisionResolutionManifestError extends Error {
	readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "WorkflowDecisionResolutionManifestError";
		this.code = code;
	}
}

const EXTERNAL_EFFECT_CLASSES = new Set<WorkflowDecisionResolutionExternalEffectClass>([
	"none",
	"user_visible_intent",
	"signed_pareto_tradeoff",
	"provider_or_cloud",
	"material_spend_or_cloud",
	"protected_read",
	"legal_or_safety",
	"credential_action",
	"irreversible_external_effect",
]);

const SOURCES = new Set<WorkflowDecisionResolutionSource>([
	"signed_user_approval",
	"durable_goal",
	"sealed_spec",
	"invariant",
	"reversible_default",
]);

function freezeValue<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeValue(child);
	return Object.freeze(value);
}

function fail(code: string, message: string): never {
	throw new WorkflowDecisionResolutionManifestError(code, message);
}

function assertNonEmptyText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) fail("invalid_text", `${field} must be non-empty.`);
}

function assertReferences(value: unknown, field: string): asserts value is readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((reference) => typeof reference !== "string" || reference.trim().length === 0) ||
		new Set(value).size !== value.length
	) {
		fail("missing_evidence_reference", `${field} must contain unique, non-empty evidence references.`);
	}
}

function assertDecisionInput(input: WorkflowDecisionResolutionDecisionInput): void {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		fail("invalid_decision", "Each decision must be an object.");
	}
	assertNonEmptyText(input.decision, "decision");
	if (!SOURCES.has(input.source))
		fail("invalid_source", `Decision source "${String(input.source)}" is not supported.`);
	if (!(["high", "medium", "low"] as const).includes(input.confidence)) {
		fail("invalid_confidence", `Decision confidence "${String(input.confidence)}" is not supported.`);
	}
	if (!(["reversible", "irreversible"] as const).includes(input.reversibility)) {
		fail("invalid_reversibility", `Decision reversibility "${String(input.reversibility)}" is not supported.`);
	}
	if (!EXTERNAL_EFFECT_CLASSES.has(input.externalEffectClass)) {
		fail(
			"invalid_external_effect_class",
			`External-effect class "${String(input.externalEffectClass)}" is not supported.`,
		);
	}
	assertReferences(input.resolutionRefs, "resolutionRefs");
	assertReferences(input.evidenceRefs, "evidenceRefs");

	const redTeam = input.redTeamChallenge;
	if (typeof redTeam !== "object" || redTeam === null || Array.isArray(redTeam)) {
		fail("missing_red_team_evidence", "redTeamChallenge must include a challenge and evidence references.");
	}
	assertNonEmptyText(redTeam.challenge, "redTeamChallenge.challenge");
	if (redTeam.outcome !== "passed") {
		fail("red_team_failed", `Decision "${input.decision}" has not passed its red-team challenge.`);
	}
	assertReferences(redTeam.evidenceRefs, "redTeamChallenge.evidenceRefs");

	if (input.externalEffectClass !== "none" && input.reversibility === "reversible") {
		fail(
			"external_effect_reframed_as_reversible",
			`Decision "${input.decision}" declares an external effect as reversible.`,
		);
	}

	if (input.source === "reversible_default") {
		const basis = input.reversibleDefaultBasis;
		if (basis === undefined) {
			fail("reversible_default_basis_missing", `Decision "${input.decision}" has no reversible-default basis.`);
		}
		if (
			typeof basis.inScope !== "boolean" ||
			typeof basis.noNewCost !== "boolean" ||
			typeof basis.safetyPreserved !== "boolean" ||
			typeof basis.noExternalAuthority !== "boolean"
		) {
			fail("reversible_default_basis_invalid", `Decision "${input.decision}" has invented default assumptions.`);
		}
		if (
			!basis.inScope ||
			!basis.noNewCost ||
			!basis.safetyPreserved ||
			!basis.noExternalAuthority ||
			input.reversibility !== "reversible" ||
			input.externalEffectClass !== "none"
		) {
			fail(
				"reversible_default_not_safe",
				`Decision "${input.decision}" is not an in-scope, no-cost, safe, authority-free reversible default.`,
			);
		}
	}

	if (input.effectAuthorizationRefs !== undefined) {
		assertReferences(input.effectAuthorizationRefs, "effectAuthorizationRefs");
	}
}

function avoidedQuestionReason(
	source: WorkflowDecisionResolutionSource,
): WorkflowDecisionResolutionAvoidedQuestionReason {
	if (source === "invariant") return "hard_invariant";
	if (source === "reversible_default") return "safe_reversible_default";
	return "already_approved";
}

function requiresDesignAuthority(input: WorkflowDecisionResolutionDecisionInput): boolean {
	return input.externalEffectClass === "signed_pareto_tradeoff" || input.confidence !== "high";
}

function questionFor(
	input: WorkflowDecisionResolutionDecisionInput,
	designSelection: WorkflowDecisionResolutionStatus,
	effectAuthorization: WorkflowDecisionResolutionEffectAuthorization,
): WorkflowDecisionResolutionQuestion | null {
	if (designSelection === "needs_authority") {
		return {
			decision: input.decision,
			reason: "design_authority_required",
			externalEffectClass: input.externalEffectClass,
			prompt: `Please authorize the design tradeoff for: ${input.decision}`,
			resolutionRefs: [...input.resolutionRefs],
			evidenceRefs: [...input.evidenceRefs],
			redTeamEvidenceRefs: [...input.redTeamChallenge.evidenceRefs],
		};
	}
	if (effectAuthorization === "needs_authority") {
		return {
			decision: input.decision,
			reason: "effect_authorization_required",
			externalEffectClass: input.externalEffectClass,
			prompt: `Please authorize the external effect for: ${input.decision}`,
			resolutionRefs: [...input.resolutionRefs],
			evidenceRefs: [...input.evidenceRefs],
			redTeamEvidenceRefs: [...input.redTeamChallenge.evidenceRefs],
		};
	}
	return null;
}

function normalizeDecision(input: WorkflowDecisionResolutionDecisionInput): {
	decision: WorkflowDecisionResolutionDecision;
	question: WorkflowDecisionResolutionQuestion | null;
	avoidedQuestion: WorkflowDecisionResolutionAvoidedQuestion | null;
} {
	assertDecisionInput(input);
	const designSelection: WorkflowDecisionResolutionStatus = requiresDesignAuthority(input)
		? "needs_authority"
		: "auto_resolved";
	const effectAuthorization: WorkflowDecisionResolutionEffectAuthorization =
		input.externalEffectClass === "none"
			? "not_required"
			: input.effectAuthorizationRefs === undefined
				? "needs_authority"
				: "authorized";
	const normalizedInput: WorkflowDecisionResolutionDecisionInput = {
		decision: input.decision,
		source: input.source,
		confidence: input.confidence,
		reversibility: input.reversibility,
		externalEffectClass: input.externalEffectClass,
		redTeamChallenge: {
			...input.redTeamChallenge,
			evidenceRefs: [...input.redTeamChallenge.evidenceRefs],
		},
		resolutionRefs: [...input.resolutionRefs],
		evidenceRefs: [...input.evidenceRefs],
		...(input.effectAuthorizationRefs === undefined
			? {}
			: { effectAuthorizationRefs: [...input.effectAuthorizationRefs] }),
		...(input.reversibleDefaultBasis === undefined
			? {}
			: { reversibleDefaultBasis: { ...input.reversibleDefaultBasis } }),
	};
	const decision: WorkflowDecisionResolutionDecision = {
		...normalizedInput,
		resolution: designSelection,
		designSelection,
		effectAuthorization,
	};
	const question = questionFor(normalizedInput, designSelection, effectAuthorization);
	const avoidedQuestion =
		designSelection === "auto_resolved"
			? {
					decision: normalizedInput.decision,
					reason: avoidedQuestionReason(normalizedInput.source),
					resolutionRefs: [...normalizedInput.resolutionRefs],
					evidenceRefs: [...normalizedInput.evidenceRefs],
					redTeamEvidenceRefs: [...normalizedInput.redTeamChallenge.evidenceRefs],
				}
			: null;
	return { decision, question, avoidedQuestion };
}

function assertManifestInput(input: WorkflowDecisionResolutionManifestInput): void {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		fail("invalid_manifest", "Decision-resolution manifest input must be an object.");
	}
	if (input.workflowId !== undefined) assertNonEmptyText(input.workflowId, "workflowId");
	if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
		fail("decisions_required", "Decision-resolution manifest requires at least one decision.");
	}
}

/**
 * Resolve brainstorming decisions against durable authority and return one bounded approval request.
 *
 * Args:
 * input: Decision records carrying authority, reversibility, effect, and evidence claims.
 * Return: Frozen manifest with separated design/effect status and batched pending questions.
 */
export function createWorkflowDecisionResolutionManifest(
	input: WorkflowDecisionResolutionManifestInput,
): WorkflowDecisionResolutionManifest {
	assertManifestInput(input);
	const normalized = input.decisions.map(normalizeDecision);
	const decisions = normalized.map((item) => item.decision);
	const pendingQuestions = normalized.flatMap((item) => (item.question === null ? [] : [item.question]));
	const questionsAvoided = normalized.flatMap((item) => (item.avoidedQuestion === null ? [] : [item.avoidedQuestion]));
	const approvalManifest: WorkflowDecisionResolutionApprovalManifest = {
		kind: "bounded_approval_manifest",
		bounded: true,
		serial: false,
		questions: pendingQuestions,
	};
	const digestInput = {
		schemaVersion: WORKFLOW_DECISION_RESOLUTION_MANIFEST_SCHEMA_VERSION,
		workflowId: input.workflowId ?? null,
		designPolicy: "fail_closed" as const,
		decisions,
		pendingQuestions,
		approvalManifest,
		questionsAvoided,
	};
	const manifest: WorkflowDecisionResolutionManifest = {
		...digestInput,
		manifestDigest: digestObject(digestInput),
	};
	return freezeValue(manifest);
}

export const buildWorkflowDecisionResolutionManifest = createWorkflowDecisionResolutionManifest;
export const resolveWorkflowDecisionResolutionManifest = createWorkflowDecisionResolutionManifest;

export type DecisionResolutionManifest = WorkflowDecisionResolutionManifest;
export type DecisionResolutionDecision = WorkflowDecisionResolutionDecision;
export type DecisionResolutionDecisionInput = WorkflowDecisionResolutionDecisionInput;
export const createDecisionResolutionManifest = createWorkflowDecisionResolutionManifest;
export const resolveDecisionResolutionManifest = createWorkflowDecisionResolutionManifest;
