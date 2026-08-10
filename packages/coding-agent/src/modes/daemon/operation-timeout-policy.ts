import type { OperationKind, OperationRecord } from "./operation-ledger.js";

export type OperationDeadlineDecision = "none" | "warn" | "cancel";
export type OperationDeadlineEnforcement = "advisory" | "owned_only";

export interface OperationTimeoutPolicy {
	timeoutClass: string;
	timeoutPolicySource: "prime-agent-default-v1";
	warningAfterMs: number;
	hardCapMs: number;
	deadlineAt: string;
	enforcement: OperationDeadlineEnforcement;
}

const FIVE_MINUTES_MS = 5 * 60_000;

const POLICY_BY_KIND: Record<OperationKind, Omit<OperationTimeoutPolicy, "deadlineAt">> = {
	turn: {
		timeoutClass: "turn-advisory-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 6 * 60 * 60_000,
		enforcement: "advisory",
	},
	provider: {
		timeoutClass: "provider-advisory-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 45 * 60_000,
		enforcement: "advisory",
	},
	tool: {
		timeoutClass: "owned-tool-hard-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 2 * 60 * 60_000,
		enforcement: "owned_only",
	},
	kernel: {
		timeoutClass: "owned-kernel-hard-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 2 * 60 * 60_000,
		enforcement: "owned_only",
	},
	bash: {
		timeoutClass: "owned-bash-hard-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 2 * 60 * 60_000,
		enforcement: "owned_only",
	},
	compaction: {
		timeoutClass: "compaction-advisory-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: 15 * 60_000,
		hardCapMs: 60 * 60_000,
		enforcement: "advisory",
	},
	retry: {
		timeoutClass: "retry-advisory-cap",
		timeoutPolicySource: "prime-agent-default-v1",
		warningAfterMs: FIVE_MINUTES_MS,
		hardCapMs: 30 * 60_000,
		enforcement: "advisory",
	},
};

export function resolveOperationTimeoutPolicy(
	kind: OperationKind,
	_detail: string | undefined,
	startedAtMs: number,
): OperationTimeoutPolicy {
	const policy = POLICY_BY_KIND[kind];
	return { ...policy, deadlineAt: new Date(startedAtMs + policy.hardCapMs).toISOString() };
}

export function evaluateOperationDeadline(
	record: OperationRecord,
	nowMs: number,
	allowOwnedCancellation = false,
): OperationDeadlineDecision {
	if (record.status !== "open" || !record.deadlineAt) return "none";
	const deadlineMs = Date.parse(record.deadlineAt);
	if (!Number.isFinite(deadlineMs) || deadlineMs > nowMs) return "none";
	const policy = POLICY_BY_KIND[record.kind];
	if (
		allowOwnedCancellation &&
		policy.enforcement === "owned_only" &&
		record.timeoutClass === policy.timeoutClass &&
		record.ownershipStatus === "owned"
	) {
		return "cancel";
	}
	return "warn";
}
