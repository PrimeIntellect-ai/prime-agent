import { isAvoFeatureAblated } from "./ablation.js";
import type { AvoCheckpoint, AvoRunState, AvoSupervisorReview } from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return value.map((item) => item.trim());
}

export function requiresAvoAdversarialReview(state: AvoRunState, cycleId?: string): boolean {
	if (isAvoFeatureAblated("adversarial_supervision")) return false;
	if (
		state.routing.environment !== "coding" ||
		state.routing.horizon === "direct" ||
		state.verificationPolicy !== "required"
	) {
		return false;
	}
	const cycle = cycleId
		? state.cycles.find((item) => item.cycleId === cycleId)
		: [...state.cycles].reverse().find((item) => item.outcome === "accepted");
	if (cycle?.outcome !== "accepted") return false;
	const criticalObligations = state.obligations.filter((item) => item.critical).length;
	return state.routing.horizon === "long" || criticalObligations >= 8;
}

export function shouldActivateAvoSupervisor(state: AvoRunState, checkpoint?: AvoCheckpoint): boolean {
	if (state.routing.horizon === "direct") return false;
	if (state.routing.horizon === "long") return true;
	if (requiresAvoAdversarialReview(state, checkpoint?.cycleId)) return true;
	return checkpoint?.interventionNeeded === true;
}

export function buildAvoSupervisorBootstrapPrompt(): string {
	return [
		"You are being reserved as the retained generic AVO trajectory supervisor.",
		"No tools are available. Do not inspect files, APIs, or the task during this bootstrap turn.",
		"Return exactly AVO_SUPERVISOR_READY in your final response and do nothing else.",
	].join("\n");
}

export function buildAvoSupervisorPrompt(
	state: AvoRunState,
	cycleId: string,
	_context: Record<string, unknown>,
	memoryContext = "",
): string {
	const adversarialReview = requiresAvoAdversarialReview(state, cycleId);
	const criticalRequirementCount = state.obligations.filter((item) => item.critical && item.kind !== "outcome").length;
	const minimumAnalyses = criticalRequirementCount >= 16 ? 3 : 1;
	return [
		adversarialReview
			? "You are the retained independent AVO acceptance reviewer. Audit the accepted coding candidate adversarially; do not repeat its implementation plan or merely summarize trajectory health."
			: "You are the retained generic AVO supervisor. Judge trajectory health, not the local polish of one answer.",
		`Evaluation adapter: ${state.routing.environment}. Horizon: ${state.routing.horizon}. Objective: ${(state.objective ?? "unspecified").slice(0, adversarialReview ? 1_000 : 2_000)}.`,
		adversarialReview
			? "No tools are available. Independently inspect only the host-bounded implementation and test excerpts in the packet. Select at most three highest-risk specification boundaries and reason through concrete counterexamples or missing behavior. Do not ask to execute code and do not repeat the implementation plan."
			: "Detect repetition, identical failures, ignored negative feedback, candidate-family collapse, unproductive tools, and unsupported assumptions.",
		adversarialReview
			? `A single broad receipt covering many obligations is a prioritization signal, not automatic failure. Return progressing only after the adversarial audit finds no concrete blocking defect. For progressing, recommended_actions must contain ${minimumAnalyses === 3 ? "exactly 3" : "1-3"} strings formatted exactly as "source=<host packet review_files path>; requirement=<host packet requirement_id>; related_requirement=<a different host packet requirement_id when testing an interaction>; counterexample=<specific input>; expected=<specific behavior>; analysis=<why the shown code handles it>". Use distinct primary requirement IDs. For a dense review, at least one analysis must combine two requirements using related_requirement; prioritize cross-surface behavior, output-shape/error contracts, empty boundaries, and feature interactions over simple happy paths. Generic assurances are invalid. Return watch when the audit could not establish readiness, and intervene when you find a reproducible defect, ignored requirement, or unsupported critical assumption. Your review may veto; it cannot create host evidence or declare success.`
			: undefined,
		"In structured experiment memory, declared_hypothesis, planned_design, reported_results, and reported_interpretation are declarations; only observed_* fields and derived_statistics are empirical evidence.",
		"You may recommend a redirect, but you cannot mutate canonical state or declare success. Host/environment receipts remain authoritative.",
		`Return the literal line AVO_SUPERVISION_JSON:${cycleId}, then one JSON object with keys cycle_id, status, reason, detected_patterns, recommended_actions.`,
		"status must be progressing, watch, or intervene. detected_patterns and recommended_actions must be arrays of strings.",
		memoryContext || undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}

export function buildAvoSupervisorMessage(
	state: AvoRunState,
	cycleId: string,
	context: Record<string, unknown>,
	memoryContext = "",
	packet?: Record<string, unknown>,
): string {
	const adversarialReview = requiresAvoAdversarialReview(state, cycleId);
	const hostPacket =
		packet ??
		(adversarialReview
			? {
					packet_version: 2,
					run_id: state.runId,
					environment: state.routing.environment,
					horizon: state.routing.horizon,
					adapter_context: context,
				}
			: buildAvoSupervisorPacket(state, context, memoryContext));
	return `${buildAvoSupervisorPrompt(state, cycleId, context, memoryContext)}\n\n[host packet]\n${JSON.stringify(hostPacket)}`;
}

export function buildAvoSupervisorPacket(
	state: AvoRunState,
	context: Record<string, unknown>,
	memoryContext = "",
): Record<string, unknown> {
	return {
		packet_version: 1,
		run_id: state.runId,
		objective: state.objective,
		environment: state.routing.environment,
		horizon: state.routing.horizon,
		recent_lineage: state.lineage.slice(-20),
		latest_checkpoint: state.checkpoints.at(-1),
		adapter_context: context,
		supervisor_memory_context: memoryContext || undefined,
	};
}

export function parseAvoSupervisorMessage(
	message: string,
	expectedCycleId: string,
	adversarialBindings?: {
		sourcePaths: readonly string[];
		requirementIds: readonly string[];
		minimumAnalyses?: number;
		requireCrossRequirement?: boolean;
	},
): Omit<AvoSupervisorReview, "reviewId" | "recordedAt" | "source"> {
	const marker = `AVO_SUPERVISION_JSON:${expectedCycleId}`;
	const markerIndex = message.indexOf(marker);
	if (markerIndex < 0) throw new Error(`supervisor response omitted ${marker}`);
	const jsonText = message.slice(markerIndex + marker.length).trim();
	const parsed = JSON.parse(jsonText) as unknown;
	if (!isRecord(parsed)) throw new Error("AVO supervisor response must be a JSON object");
	if (parsed.cycle_id !== expectedCycleId) throw new Error("AVO supervisor response references another cycle");
	if (parsed.status !== "progressing" && parsed.status !== "watch" && parsed.status !== "intervene") {
		throw new Error("AVO supervisor status must be progressing, watch, or intervene");
	}
	if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
		throw new Error("AVO supervisor reason must be a non-empty string");
	}
	const detectedPatterns = stringArray(parsed.detected_patterns, "detected_patterns");
	const recommendedActions = stringArray(parsed.recommended_actions, "recommended_actions");
	const parsedActions = recommendedActions.map((action) => {
		const fields = new Map(
			action.split(";").flatMap((part) => {
				const separator = part.indexOf("=");
				return separator > 0 ? [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const] : [];
			}),
		);
		return { action, fields };
	});
	const minimumAnalyses = adversarialBindings?.minimumAnalyses ?? 1;
	const primaryRequirementIds = parsedActions.map((item) => item.fields.get("requirement") ?? "");
	const adversarialEvidenceValid =
		!adversarialBindings ||
		(parsed.status === "progressing" &&
			recommendedActions.length >= minimumAnalyses &&
			recommendedActions.length <= 3 &&
			new Set(primaryRequirementIds).size === primaryRequirementIds.length &&
			parsedActions.every(({ fields }) => {
				return (
					adversarialBindings.sourcePaths.includes(fields.get("source") ?? "") &&
					adversarialBindings.requirementIds.includes(fields.get("requirement") ?? "") &&
					["counterexample", "expected", "analysis"].every((field) => (fields.get(field)?.length ?? 0) >= 4)
				);
			}) &&
			(!adversarialBindings.requireCrossRequirement ||
				parsedActions.some(({ fields }) => {
					const requirement = fields.get("requirement") ?? "";
					const relatedRequirement = fields.get("related_requirement") ?? "";
					return (
						relatedRequirement !== requirement && adversarialBindings.requirementIds.includes(relatedRequirement)
					);
				}))) ||
		parsed.status !== "progressing";
	const status = adversarialBindings && !adversarialEvidenceValid ? "watch" : parsed.status;
	return {
		cycleId: expectedCycleId,
		status,
		reason:
			status !== parsed.status
				? "the retained acceptance reviewer returned an uncalibrated progressing verdict without the required distinct host-bound counterexample analyses"
				: parsed.reason.trim(),
		detectedPatterns:
			status !== parsed.status ? [...detectedPatterns, "uncalibrated_adversarial_review"] : detectedPatterns,
		recommendedActions,
	};
}

export function findAvoSupervisorResponseText(messages: readonly string[], cycleId: string): string | undefined {
	const marker = `AVO_SUPERVISION_JSON:${cycleId}`;
	return [...messages].reverse().find((message) => message.includes(marker));
}
