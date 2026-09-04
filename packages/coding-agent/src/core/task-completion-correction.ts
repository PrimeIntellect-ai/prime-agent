import { AgentTaskGraphError, type AgentTaskResult } from "./task-graph.js";

export const AGENT_TASK_COMPLETION_CORRECTION_MAX_ATTEMPTS = 3;

export interface AgentTaskCompletionCorrection {
	taskId: string;
	hostSummary: string;
	requiredEvidenceRefs: readonly string[];
	initialError: Error;
	lastAttemptError?: Error;
	actionAttempts: number;
	actionCompleted: boolean;
}

export function createTaskCompletionCorrection(input: {
	taskId: string;
	hostSummary: string;
	requiredEvidenceRefs: readonly string[];
	initialError: Error;
}): AgentTaskCompletionCorrection {
	return {
		...input,
		requiredEvidenceRefs: [...input.requiredEvidenceRefs],
		actionAttempts: 0,
		actionCompleted: false,
	};
}

export function beginTaskCompletionCorrectionAction(correction: AgentTaskCompletionCorrection): void {
	if (correction.actionCompleted) {
		throw new AgentTaskGraphError("task completion correction already completed its bounded action");
	}
	if (correction.actionAttempts >= AGENT_TASK_COMPLETION_CORRECTION_MAX_ATTEMPTS) {
		throw new AgentTaskGraphError(
			`task completion correction exhausted its ${AGENT_TASK_COMPLETION_CORRECTION_MAX_ATTEMPTS} action attempts`,
		);
	}
	correction.actionAttempts += 1;
}

export function constrainTaskCompletionCorrectionResult(
	correction: AgentTaskCompletionCorrection,
	result: AgentTaskResult,
	durableEvidenceRefs: readonly string[],
): AgentTaskResult {
	const submittedEvidence = Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [];
	return {
		...result,
		summary: correction.hostSummary,
		evidenceRefs: stableStringUnion(
			stableStringUnion(correction.requiredEvidenceRefs, durableEvidenceRefs),
			submittedEvidence,
		),
	};
}

export function recordTaskCompletionCorrectionFailure(
	correction: AgentTaskCompletionCorrection,
	error: unknown,
): boolean {
	correction.lastAttemptError = error instanceof Error ? error : new Error(String(error));
	return correction.actionAttempts >= AGENT_TASK_COMPLETION_CORRECTION_MAX_ATTEMPTS;
}

export function completeTaskCompletionCorrectionAction(correction: AgentTaskCompletionCorrection): void {
	correction.actionCompleted = true;
}

export function taskCompletionCorrectionFailure(
	taskId: string,
	initialError: Error,
	correctionError: unknown,
): AgentTaskGraphError {
	const correction = correctionError instanceof Error ? correctionError : new Error(String(correctionError));
	return new AgentTaskGraphError(`task ${taskId} completion correction failed: ${correction.message}`, {
		cause: new AggregateError(
			[initialError, correction],
			`automatic completion and its bounded correction both failed for task ${taskId}`,
		),
	});
}

function stableStringUnion(left: readonly string[], right: readonly string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const value of [...left, ...right]) {
		if (seen.has(value)) continue;
		seen.add(value);
		merged.push(value);
	}
	return merged;
}
