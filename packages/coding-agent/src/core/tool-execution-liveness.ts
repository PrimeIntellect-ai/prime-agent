export const TOOL_EXECUTION_STALL_CUSTOM_TYPE = "tool_execution_stalled";
export const TOOL_EXECUTION_LEASE_CUSTOM_TYPE = "tool_execution_lease";

export interface ToolExecutionLiveness {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly startedAt: string;
	readonly lastProgressAt: string;
	readonly deadlineAt: string;
	readonly hardDeadlineAt: string;
	readonly leaseDurationMs: number;
	readonly progressEventCount: number;
	readonly phase: "running" | "stalled";
}

export interface ToolExecutionStallDiagnostic extends ToolExecutionLiveness {
	readonly type: "tool_execution_stalled";
	readonly detectedAt: string;
	readonly reason: "deadline_exceeded";
}

export interface ToolExecutionLeaseRecord {
	readonly type: "tool_execution_lease";
	readonly schemaVersion: 1;
	readonly status: "active" | "released";
	readonly liveness: ToolExecutionLiveness;
	readonly recordedAt: string;
	readonly recordDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolExecutionLiveness(value: unknown): value is ToolExecutionLiveness {
	if (!isRecord(value)) return false;
	return (
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0 &&
		typeof value.toolName === "string" &&
		value.toolName.length > 0 &&
		typeof value.startedAt === "string" &&
		typeof value.lastProgressAt === "string" &&
		typeof value.deadlineAt === "string" &&
		typeof value.hardDeadlineAt === "string" &&
		Number.isFinite(Date.parse(value.startedAt)) &&
		Number.isFinite(Date.parse(value.lastProgressAt)) &&
		Number.isFinite(Date.parse(value.deadlineAt)) &&
		Number.isFinite(Date.parse(value.hardDeadlineAt)) &&
		Date.parse(value.deadlineAt) <= Date.parse(value.hardDeadlineAt) &&
		Number.isSafeInteger(value.leaseDurationMs) &&
		(value.leaseDurationMs as number) > 0 &&
		Number.isSafeInteger(value.progressEventCount) &&
		(value.progressEventCount as number) >= 0 &&
		value.phase === "running"
	);
}

/** Parse one immutable tool-lease lifecycle record from the session journal. */
export function parseToolExecutionLeaseRecord(value: unknown): ToolExecutionLeaseRecord | undefined {
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value).sort();
	if (
		JSON.stringify(keys) !==
			JSON.stringify(["liveness", "recordDigest", "recordedAt", "schemaVersion", "status", "type"].sort()) ||
		value.type !== "tool_execution_lease" ||
		value.schemaVersion !== 1 ||
		(value.status !== "active" && value.status !== "released") ||
		!isToolExecutionLiveness(value.liveness) ||
		typeof value.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(value.recordedAt)) ||
		typeof value.recordDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.recordDigest)
	)
		return undefined;
	return value as unknown as ToolExecutionLeaseRecord;
}

/** Parse one persisted tool-stall diagnostic without trusting arbitrary custom-message data. */
export function parseToolExecutionStallDiagnostic(value: unknown): ToolExecutionStallDiagnostic | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.type !== "tool_execution_stalled" ||
		value.reason !== "deadline_exceeded" ||
		value.phase !== "stalled" ||
		typeof value.toolCallId !== "string" ||
		value.toolCallId.length === 0 ||
		typeof value.toolName !== "string" ||
		value.toolName.length === 0 ||
		typeof value.startedAt !== "string" ||
		typeof value.lastProgressAt !== "string" ||
		typeof value.deadlineAt !== "string" ||
		typeof value.hardDeadlineAt !== "string" ||
		typeof value.detectedAt !== "string" ||
		!Number.isFinite(Date.parse(value.startedAt)) ||
		!Number.isFinite(Date.parse(value.lastProgressAt)) ||
		!Number.isFinite(Date.parse(value.deadlineAt)) ||
		!Number.isFinite(Date.parse(value.hardDeadlineAt)) ||
		!Number.isFinite(Date.parse(value.detectedAt)) ||
		!Number.isSafeInteger(value.leaseDurationMs) ||
		(value.leaseDurationMs as number) <= 0 ||
		!Number.isSafeInteger(value.progressEventCount) ||
		(value.progressEventCount as number) < 0
	)
		return undefined;
	return {
		type: "tool_execution_stalled",
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		startedAt: value.startedAt,
		lastProgressAt: value.lastProgressAt,
		deadlineAt: value.deadlineAt,
		hardDeadlineAt: value.hardDeadlineAt,
		leaseDurationMs: value.leaseDurationMs as number,
		progressEventCount: value.progressEventCount as number,
		phase: "stalled",
		detectedAt: value.detectedAt,
		reason: "deadline_exceeded",
	};
}
