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

export function shouldActivateAvoSupervisor(state: AvoRunState, checkpoint?: AvoCheckpoint): boolean {
	if (state.routing.horizon === "direct") return false;
	if (state.routing.horizon === "long") return true;
	return checkpoint?.interventionNeeded === true;
}

export function buildAvoSupervisorBootstrapPrompt(): string {
	return [
		"You are being reserved as the retained generic AVO trajectory supervisor.",
		"Do not inspect files, APIs, tools, or the task during this bootstrap turn.",
		"Send exactly AVO_SUPERVISOR_READY to the parent and do nothing else.",
	].join("\n");
}

export function buildAvoSupervisorPrompt(
	state: AvoRunState,
	cycleId: string,
	context: Record<string, unknown>,
): string {
	return [
		"You are the retained generic AVO supervisor. Judge trajectory health, not the local polish of one answer.",
		`Environment: ${state.routing.environment}. Horizon: ${state.routing.horizon}. Objective: ${(state.objective ?? "unspecified").slice(0, 2_000)}.`,
		"Detect repetition, identical failures, ignored negative feedback, candidate-family collapse, unproductive tools, and unsupported assumptions.",
		"You may recommend a redirect, but you cannot mutate canonical state or declare success. Host/environment receipts remain authoritative.",
		`Send the literal line AVO_SUPERVISION_JSON:${cycleId}, then one JSON object with keys cycle_id, status, reason, detected_patterns, recommended_actions.`,
		"status must be progressing, watch, or intervene. detected_patterns and recommended_actions must be arrays of strings.",
		JSON.stringify(context),
	].join("\n\n");
}

export function buildAvoSupervisorPacket(
	state: AvoRunState,
	context: Record<string, unknown>,
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
	};
}

export function parseAvoSupervisorMessage(
	message: string,
	expectedCycleId: string,
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
	return {
		cycleId: expectedCycleId,
		status: parsed.status,
		reason: parsed.reason.trim(),
		detectedPatterns: stringArray(parsed.detected_patterns, "detected_patterns"),
		recommendedActions: stringArray(parsed.recommended_actions, "recommended_actions"),
	};
}
