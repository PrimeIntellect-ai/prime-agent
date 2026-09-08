import type { TelemetryErrorComponent, TelemetryErrorRecoveryAction } from "./telemetry-error-classification.js";
import type { TelemetryProperties } from "./telemetry-schema.js";

export interface TelemetryRecoveryScope {
	sessionId?: string;
	clientSessionId?: string;
	runId?: string;
	providerCategory?: string;
	targetProviderCategory?: string;
	retryBackoffMs?: number;
	components?: readonly TelemetryErrorComponent[];
}

interface RecoveryOptions {
	isEnabled: () => boolean;
	now?: () => number;
	maxErrors?: number;
	retentionMs?: number;
}

interface PendingError {
	properties: TelemetryProperties;
	at: number;
	group: string;
	targetProvider?: string;
}

const COUNTER_LIMIT = 1_000_000;
const DAY_MS = 86_400_000;

/** Tracks observed sequences only; a later success does not establish what caused recovery. */
export class TelemetryErrorRecoveryTracker {
	private readonly pending = new Map<string, PendingError>();
	private readonly counts = new Map<string, number>();
	private readonly now: () => number;
	private readonly maximum: number;
	private readonly retentionMs: number;

	constructor(private readonly options: RecoveryOptions) {
		this.now = options.now ?? Date.now;
		this.maximum = Math.max(1, Math.min(128, options.maxErrors ?? 128));
		this.retentionMs = Math.max(1, Math.min(DAY_MS, options.retentionMs ?? DAY_MS));
	}

	private enabled(): boolean {
		try {
			if (this.options.isEnabled()) return true;
		} catch {
			// Consent lookup failure is disabled telemetry.
		}
		this.clear();
		return false;
	}

	private prune(): void {
		const oldest = this.now() - this.retentionMs;
		for (const [id, error] of this.pending) {
			if (error.at < oldest) {
				this.pending.delete(id);
				this.counts.delete(error.group);
			}
		}
		while (this.pending.size > this.maximum) {
			const first = this.pending.entries().next().value;
			if (!first) break;
			this.pending.delete(first[0]);
			this.counts.delete(first[1].group);
		}
		while (this.counts.size > this.maximum) {
			const first = this.counts.keys().next().value;
			if (first === undefined) break;
			this.counts.delete(first);
		}
	}

	recordFailure(properties: TelemetryProperties): TelemetryProperties | undefined {
		if (!this.enabled()) return undefined;
		this.prune();
		const id = properties.error_id;
		if (typeof id !== "string") return undefined;
		const previous = this.pending.get(id);
		if (previous)
			return {
				...previous.properties,
				...properties,
				consecutive_failure_count: previous.properties.consecutive_failure_count,
			};
		const group = JSON.stringify([
			properties.session_id ?? properties.client_session_id ?? "unscoped",
			properties.component,
			properties.provider_category,
			typeof properties.error_code_group === "string" && properties.error_code_group !== "unknown"
				? properties.error_code_group
				: `${properties.error_type}:${properties.error_subtype}`,
		]);
		const supplied = properties.consecutive_failure_count;
		const count = Math.min(
			COUNTER_LIMIT,
			Math.max(
				(this.counts.get(group) ?? 0) + 1,
				typeof supplied === "number" && Number.isFinite(supplied) ? supplied : 0,
			),
		);
		this.counts.set(group, count);
		const report = { ...properties, consecutive_failure_count: count, error_event_kind: "occurrence" };
		this.pending.set(id, { properties: report, at: this.now(), group });
		this.prune();
		return report;
	}

	private matches(error: PendingError, scope: TelemetryRecoveryScope, requireRun: boolean): boolean {
		const properties = error.properties;
		if (scope.components && !scope.components.some((component) => component === properties.component)) return false;
		// Worker session identity takes precedence over long-lived client/onboarding metadata.
		if (scope.sessionId) {
			if (properties.session_id !== scope.sessionId) return false;
		} else if (scope.clientSessionId) {
			if (properties.session_id || properties.client_session_id !== scope.clientSessionId) return false;
		} else return false;
		if (requireRun && scope.runId && properties.run_id && properties.run_id !== scope.runId) return false;
		if (
			scope.providerCategory &&
			properties.provider_category !== scope.providerCategory &&
			error.targetProvider !== scope.providerCategory
		)
			return false;
		return true;
	}

	finishErrors(errorIds: readonly string[], scope: TelemetryRecoveryScope): TelemetryProperties[] {
		if (!this.enabled()) return [];
		this.prune();
		const updates: TelemetryProperties[] = [];
		for (const id of new Set(errorIds.slice(0, this.maximum))) {
			const error = this.pending.get(id);
			if (!error || !this.matches(error, scope, true)) continue;
			updates.push({ ...error.properties, error_event_kind: "recovery_update", recovery_outcome: "success" });
			this.pending.delete(id);
			if (![...this.pending.values()].some((remaining) => remaining.group === error.group))
				this.counts.delete(error.group);
		}
		return updates;
	}

	noteRecoveryAction(action: TelemetryErrorRecoveryAction, scope: TelemetryRecoveryScope = {}): TelemetryProperties[] {
		if (!this.enabled()) return [];
		if (action === "none" || action === "unknown") return [];
		this.prune();
		const updates: TelemetryProperties[] = [];
		for (const error of this.pending.values()) {
			if (!this.matches(error, scope, action === "automatic_retry")) continue;
			error.targetProvider = scope.targetProviderCategory;
			error.properties = {
				...error.properties,
				error_event_kind: "recovery_update",
				recovery_action: action,
				recovery_outcome: action === "cancelled" ? "cancelled" : "pending",
				...(typeof scope.retryBackoffMs === "number" &&
				Number.isFinite(scope.retryBackoffMs) &&
				scope.retryBackoffMs >= 0
					? { retry_backoff_ms: Math.min(DAY_MS, scope.retryBackoffMs) }
					: {}),
			};
			updates.push({ ...error.properties });
		}
		return updates;
	}

	finishRun(
		scope: TelemetryRecoveryScope & {
			runId: string;
			outcome: "success" | "error" | "cancelled" | "shutdown_interrupted" | "unknown";
		},
	): TelemetryProperties[] {
		if (!this.enabled()) return [];
		this.prune();
		const updates: TelemetryProperties[] = [];
		for (const [id, error] of this.pending) {
			if (!this.matches(error, scope, scope.outcome !== "success")) continue;
			const properties = error.properties;
			const actionable = properties.recovery_outcome === "pending";
			const runRelated = ["provider", "authentication", "session"].includes(String(properties.component));
			if (!actionable && !(runRelated && scope.outcome === "success")) continue;
			const outcome =
				scope.outcome === "success"
					? "success"
					: scope.outcome === "error"
						? "failed"
						: scope.outcome === "cancelled"
							? "cancelled"
							: "unknown";
			error.properties = { ...properties, error_event_kind: "recovery_update", recovery_outcome: outcome };
			updates.push({ ...error.properties });
			if (scope.outcome === "success") {
				this.pending.delete(id);
				this.counts.delete(error.group);
			}
		}
		return updates;
	}

	clear(): void {
		this.pending.clear();
		this.counts.clear();
	}
}

const trackers = new WeakMap<object, Map<string, TelemetryErrorRecoveryTracker>>();

export function getTelemetryErrorRecoveryTracker(
	owner: object,
	scope: string,
	options: RecoveryOptions,
): TelemetryErrorRecoveryTracker {
	let contexts = trackers.get(owner);
	if (!contexts) {
		contexts = new Map();
		trackers.set(owner, contexts);
	}
	let tracker = contexts.get(scope);
	if (!tracker) {
		tracker = new TelemetryErrorRecoveryTracker(options);
		contexts.set(scope, tracker);
	}
	return tracker;
}
