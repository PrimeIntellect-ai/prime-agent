import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sleep } from "../utils/sleep.js";
import type { SettingsManager } from "./settings-manager.js";

/**
 * Shared provider-retry policy: the single definition of which structured
 * provider failures are permanent and how long to wait before a retry
 * (exponential backoff, raised to a server-requested Retry-After, capped by
 * retry.provider.maxRetryDelayMs). The AgentSession auto-retry loop and the
 * one-shot completion consumers (side questions, compaction, refinement,
 * session summaries) both consume this policy so they cannot drift.
 */
export interface ProviderRetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	/** Max server-requested retry delay before giving up; 0 disables the cap. */
	maxRetryDelayMs: number;
}

export function providerRetryPolicy(settingsManager: SettingsManager): ProviderRetryPolicy {
	return {
		...settingsManager.getRetrySettings(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	};
}

/** Local listener/lifecycle crashes are not provider failures; never retry them. */
export function isAgentLifecycleFailure(message: AssistantMessage): boolean {
	return message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure") ?? false;
}

/** The faux test provider's queue running dry is deterministic; retrying it only stalls tests. */
export function isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
	return message.provider === "faux" && message.errorMessage === "No more faux responses queued";
}

export function providerStreamFailureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
	const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
	const details = failure?.details;
	if (!details || typeof details !== "object") {
		return undefined;
	}
	return details;
}

export function providerStreamFailureKind(message: AssistantMessage): string | undefined {
	const kind = providerStreamFailureDetails(message)?.kind;
	return typeof kind === "string" ? kind : undefined;
}

export function providerStreamFailureRetryAfterMs(message: AssistantMessage): number | undefined {
	const value = providerStreamFailureDetails(message)?.retryAfterMs;
	return typeof value === "number" && value >= 0 ? value : undefined;
}

/**
 * Deterministic rejections never warrant a retry; auth failures get one
 * retry so a transient auth hiccup does not immediately mark auth stale.
 */
export function isPermanentProviderFailureKind(kind: string | undefined, retriesPerformed: number): boolean {
	if (kind === "invalid_request" || kind === "refusal") {
		return true;
	}
	return retriesPerformed > 0 && kind === "auth";
}

export type ProviderRetryDelay = { kind: "wait"; delayMs: number } | { kind: "exceeds-cap"; retryAfterMs: number };

/** Delay before retry `attempt` (1-based), honoring a server-requested wait. */
export function providerRetryDelay(
	attempt: number,
	retryAfterMs: number | undefined,
	policy: Pick<ProviderRetryPolicy, "baseDelayMs" | "maxRetryDelayMs">,
): ProviderRetryDelay {
	if (retryAfterMs !== undefined && policy.maxRetryDelayMs > 0 && retryAfterMs > policy.maxRetryDelayMs) {
		return { kind: "exceeds-cap", retryAfterMs };
	}
	return { kind: "wait", delayMs: Math.max(policy.baseDelayMs * 2 ** (attempt - 1), retryAfterMs ?? 0) };
}

/**
 * Run a one-shot completion with the shared retry policy. For consumers that
 * do not go through the AgentSession auto-retry loop (side questions,
 * compaction/branch summarization, refinement, daemon session summaries):
 * without this they would make exactly one attempt, since provider SDKs no
 * longer retry internally.
 */
export async function completeWithProviderRetry(
	attemptCompletion: () => Promise<AssistantMessage>,
	options?: { policy?: ProviderRetryPolicy; signal?: AbortSignal },
): Promise<AssistantMessage> {
	const policy = options?.policy ?? DEFAULT_PROVIDER_RETRY_POLICY;
	const maxRetries = policy.enabled ? policy.maxRetries : 0;
	let retriesPerformed = 0;
	for (;;) {
		const message = await attemptCompletion();
		if (message.stopReason !== "error") {
			return message;
		}
		if (options?.signal?.aborted) {
			// A cancel that raced the failure is an abort, not a provider failure.
			return { ...message, stopReason: "aborted" };
		}
		if (retriesPerformed >= maxRetries || isAgentLifecycleFailure(message) || isFauxProviderQueueExhausted(message)) {
			return message;
		}
		const kind = providerStreamFailureKind(message);
		if (isPermanentProviderFailureKind(kind, retriesPerformed)) {
			return message;
		}
		const delay = providerRetryDelay(retriesPerformed + 1, providerStreamFailureRetryAfterMs(message), policy);
		if (delay.kind === "exceeds-cap") {
			return message;
		}
		try {
			await sleep(delay.delayMs, options?.signal);
		} catch {
			return { ...message, stopReason: "aborted" };
		}
		retriesPerformed++;
	}
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxRetryDelayMs: 60000,
};
