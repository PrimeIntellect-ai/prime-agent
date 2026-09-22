import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sleep } from "../utils/sleep.js";
import type { SettingsManager } from "./settings-manager.js";

/**
 * The single retry policy (permanent kinds, Retry-After-aware capped delays),
 * shared by the AgentSession auto-retry loop and the one-shot completion
 * consumers (side questions, compaction, refinement, session summaries).
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

export function providerStreamFailureStatus(message: AssistantMessage): number | undefined {
	const value = providerStreamFailureDetails(message)?.status;
	return typeof value === "number" ? value : undefined;
}

/**
 * Deterministic rejections never retry; auth gets one retry before it can be
 * marked stale. A 404 is the exception: a live model briefly 404s on routing
 * blips (observed 2026-09-13 killing every active session), so it counts as
 * transient unavailability, not a permanent rejection. Safety filters
 * deterministically reject identical requests, so they never retry.
 */
export function isPermanentProviderFailureKind(
	kind: string | undefined,
	retriesPerformed: number,
	status?: number,
): boolean {
	if (kind === "invalid_request" && status === 404) {
		return false;
	}
	if (kind === "invalid_request" || kind === "refusal" || kind === "permission" || kind === "safety") {
		return true;
	}
	return retriesPerformed > 0 && kind === "auth";
}

export type ProviderRetryDelay = { kind: "wait"; delayMs: number } | { kind: "exceeds-cap"; retryAfterMs: number };

/** Node caps timers at 2^31-1 ms; longer delays overflow setTimeout and fire after ~1ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Delay before retry `attempt` (1-based). A server-requested wait at or above the backoff is used as-is;
 * otherwise the backoff is jittered so concurrent sessions do not retry in lockstep, floored at the server wait.
 */
export function providerRetryDelay(
	attempt: number,
	retryAfterMs: number | undefined,
	policy: Pick<ProviderRetryPolicy, "baseDelayMs" | "maxRetryDelayMs">,
	rng: () => number = Math.random,
): ProviderRetryDelay {
	if (retryAfterMs !== undefined && policy.maxRetryDelayMs > 0 && retryAfterMs > policy.maxRetryDelayMs) {
		return { kind: "exceeds-cap", retryAfterMs };
	}
	const backoffMs = policy.baseDelayMs * 2 ** (attempt - 1);
	if (retryAfterMs !== undefined && retryAfterMs >= backoffMs) {
		return { kind: "wait", delayMs: Math.min(retryAfterMs, MAX_TIMER_DELAY_MS) };
	}
	const jitteredMs = providerWaitJitter(backoffMs, rng);
	const flooredMs = Math.max(jitteredMs, retryAfterMs ?? 0);
	const clampedMs = Math.min(flooredMs, MAX_TIMER_DELAY_MS);
	return { kind: "wait", delayMs: clampedMs };
}

/**
 * One-shot completion with the shared retry policy, for consumers outside the
 * AgentSession auto-retry loop (provider SDKs never retry internally).
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
		if (isPermanentProviderFailureKind(kind, retriesPerformed, providerStreamFailureStatus(message))) {
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

// ---------------------------------------------------------------------------
// Wait-for-recovery: bounded waits for quota exhaustion and provider
// unavailability, with exponential-backoff pings and a user-defined backup
// model. All decision logic is pure and clock-free so tests stay
// deterministic; the session loop owns the actual sleep/continue cycle.
// ---------------------------------------------------------------------------

/** Recovery routing for a structured provider failure. */
export type ProviderWaitClass = "quota" | "transient" | "permanent";

/**
 * Classify a structured provider failure for wait-for-recovery routing.
 *
 * - quota: subscription/rate-limit exhaustion (429, usage limits, throttling).
 *   Waiting can help: usage windows reset.
 * - transient: provider unavailability. 404 counts: a live model briefly
 *   404s on routing blips (observed killing active sessions), and the same
 *   shape can also mean a genuinely missing model, so waits stay bounded.
 * - permanent: auth/permission/refusal/invalid requests. Waiting cannot help.
 */
export function providerWaitClass(kind: string | undefined, status: number | undefined): ProviderWaitClass {
	if (kind === "rate_limit" || kind === "quota") return "quota";
	if (kind === "server_error" || kind === "overloaded" || kind === "unknown") return "transient";
	if (kind === "invalid_request" && status === 404) return "transient";
	return "permanent";
}

export interface ProviderWaitPolicy {
	enabled: boolean;
	/** First blind-ping delay. Default 1s. */
	baseDelayMs: number;
	/** Per-ping ceiling for blind pings. Default 5m. */
	maxDelayMs: number;
	/** Abort bound: maximum ping attempts. Default 30. */
	maxAttempts: number;
	/** Abort bound: maximum total wait. Default 15m. */
	maxWaitMs: number;
	/** Park sessions for provider-reported resets beyond maxWaitMs. Default true. */
	pauseUntilReset: boolean;
	/** Abort bound: maximum single park duration. Default 24h, clamped to 7d. */
	maxPauseMs: number;
	/** Abort bound: maximum parks per quota episode. Default 8. */
	maxParks: number;
}

export const DEFAULT_PROVIDER_WAIT_POLICY: ProviderWaitPolicy = {
	enabled: true,
	baseDelayMs: 1000,
	maxDelayMs: 300_000,
	maxAttempts: 30,
	maxWaitMs: 900_000,
	pauseUntilReset: true,
	maxPauseMs: 86_400_000,
	maxParks: 8,
};

/** Parks wake slightly after the reported reset so the window has actually rolled over. */
export const PROVIDER_RESUME_GRACE_MS = 30_000;

/** Upper clamp for maxPauseMs: one week per park, so long-horizon resets still get probed. */
export const MAX_PROVIDER_PAUSE_MS = 7 * 86_400_000;

export type ProviderParkDecision =
	| { kind: "park"; delayMs: number }
	| { kind: "none"; reason: "disabled" | "park-budget" | "no-reset" };

/**
 * Park decision after a quota failure whose provider-reported reset time exceeds
 * the bounded wait: the session ends the turn cleanly and wakes at the reset
 * (plus a small grace), capped at maxPauseMs. Only a provider-reported reset
 * parks: without one, the bounded wait keeps its existing abort behavior.
 */
export function providerParkDecision(
	parksUsed: number,
	resetMs: number | undefined,
	policy: Pick<ProviderWaitPolicy, "pauseUntilReset" | "maxPauseMs" | "maxParks">,
): ProviderParkDecision {
	if (!policy.pauseUntilReset) {
		return { kind: "none", reason: "disabled" };
	}
	if (parksUsed >= policy.maxParks) {
		return { kind: "none", reason: "park-budget" };
	}
	if (resetMs === undefined) {
		return { kind: "none", reason: "no-reset" };
	}
	return { kind: "park", delayMs: Math.min(resetMs + PROVIDER_RESUME_GRACE_MS, policy.maxPauseMs) };
}

export type ProviderWaitDecision =
	| { kind: "wait"; delayMs: number }
	| { kind: "abort"; reason: "attempts" | "duration" | "reset-too-far"; message: string };

/** Pure exponential ping schedule: base * 2^(attempt-1), capped at maxDelayMs. */
export function providerWaitPingDelay(
	attempt: number,
	policy: Pick<ProviderWaitPolicy, "baseDelayMs" | "maxDelayMs">,
): number {
	const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
	const capped = Number.isFinite(exponential) ? Math.min(exponential, policy.maxDelayMs) : policy.maxDelayMs;
	return Math.min(capped, MAX_TIMER_DELAY_MS);
}

/** +/-25% jitter around a delay (avoids thundering-herd retries). */
export function providerWaitJitter(delayMs: number, rng: () => number = Math.random): number {
	const factor = 0.75 + 0.5 * Math.max(0, Math.min(1, rng()));
	return Math.max(0, Math.round(delayMs * factor));
}

function formatWaitDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Bounded wait decision for recovery ping `attempt` (1-based) after `elapsedMs`
 * already spent waiting. When the provider reports a reset time (`resetMs` from
 * Retry-After headers or parsed from the error text), the resume is scheduled
 * exactly then; blind pings grow exponentially with jitter. Both abort bounds
 * (`maxAttempts`, `maxWaitMs`) are hard stops so a wait can never hang.
 */
export function providerWaitDecision(
	attempt: number,
	elapsedMs: number,
	resetMs: number | undefined,
	policy: ProviderWaitPolicy,
	rng: () => number = Math.random,
): ProviderWaitDecision {
	if (attempt > policy.maxAttempts) {
		return {
			kind: "abort",
			reason: "attempts",
			message: `Provider recovery wait gave up after ${policy.maxAttempts} pings (retry.provider.waitForUsage.maxAttempts)`,
		};
	}
	const remainingMs = policy.maxWaitMs - elapsedMs;
	if (remainingMs <= 0) {
		return {
			kind: "abort",
			reason: "duration",
			message: `Provider recovery wait exceeded its bound of ${formatWaitDuration(policy.maxWaitMs)} (retry.provider.waitForUsage.maxWaitMs)`,
		};
	}
	if (resetMs !== undefined) {
		if (resetMs > remainingMs) {
			return {
				kind: "abort",
				reason: "reset-too-far",
				message: `Provider reported recovery in ${formatWaitDuration(resetMs)}, beyond the configured wait bound of ${formatWaitDuration(policy.maxWaitMs)} (retry.provider.waitForUsage.maxWaitMs)`,
			};
		}
		return { kind: "wait", delayMs: Math.min(Math.max(resetMs, 0), MAX_TIMER_DELAY_MS) };
	}
	const pingMs = providerWaitJitter(providerWaitPingDelay(attempt, policy), rng);
	return { kind: "wait", delayMs: Math.min(pingMs, remainingMs) };
}

const RESET_UNIT_MS: Record<string, number> = {
	second: 1000,
	sec: 1000,
	minute: 60_000,
	min: 60_000,
	hour: 3_600_000,
	hr: 3_600_000,
	day: 86_400_000,
};

/**
 * Parse a provider-reported recovery window from error text, e.g. the
 * ChatGPT-plan 429 "You have hit your ChatGPT usage limit ... Try again in
 * ~7272 min." Returns milliseconds, or undefined when no window is named.
 */
export function parseProviderResetMs(text: string | undefined): number | undefined {
	if (!text) return undefined;
	const match =
		/(?:try again|resets?|available)[^.]{0,80}?(?:~\s*)?(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(
			text,
		);
	if (!match) return undefined;
	const unitMs = RESET_UNIT_MS[match[2].toLowerCase().replace(/s$/, "")];
	if (!unitMs) return undefined;
	const resetMs = Number(match[1]) * unitMs;
	if (!Number.isFinite(resetMs) || resetMs < 0) return undefined;
	return Math.min(resetMs, MAX_TIMER_DELAY_MS);
}
