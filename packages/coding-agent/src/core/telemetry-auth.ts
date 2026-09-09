import { captureTelemetryEvent, isTelemetryEnabled } from "./telemetry.js";
import { telemetryProviderCategory } from "./telemetry-categories.js";
import type { TelemetryErrorOperation } from "./telemetry-error-classification.js";
import { getTelemetryErrorRecoveryTracker, type TelemetryRecoveryScope } from "./telemetry-error-recovery.js";
import { captureTelemetryError, type TelemetryErrorContext, withTelemetryErrorContext } from "./telemetry-errors.js";
import { isTelemetryUuid } from "./telemetry-schema.js";

export interface TelemetryAuthenticationAttempt {
	run<T>(callback: () => T): T;
	validation(outcome: "completed" | "failed"): void;
	reportError(error: unknown, operation: TelemetryErrorOperation): void;
	finish(outcome: "completed" | "failed" | "canceled"): boolean;
}

export function beginTelemetryAuthentication(
	options: TelemetryErrorContext & { provider: string; clientSessionId: string },
): TelemetryAuthenticationAttempt {
	const context: TelemetryErrorContext = { ...options };
	let finished = false;
	let validated = false;
	const enabled = () => {
		try {
			if (!context.telemetryDisabled && isTelemetryEnabled(context.settingsManager)) return true;
		} catch {
			// An unavailable consent check disables this attempt permanently.
		}
		context.telemetryDisabled = true;
		return false;
	};
	if (!isTelemetryUuid(context.clientSessionId)) context.telemetryDisabled = true;
	enabled();
	const unsubscribe = context.settingsManager.subscribeTelemetryEnabled(enabled);
	const scope: TelemetryRecoveryScope = {
		clientSessionId: context.clientSessionId,
		providerCategory: telemetryProviderCategory(options.provider),
		providerIdentity: options.provider,
		components: ["authentication"],
		operations: ["login", "validate"],
	};
	return {
		run: (callback) => withTelemetryErrorContext(context, callback),
		validation: (outcome) => {
			if (!finished && enabled()) validated = outcome === "completed";
		},
		reportError: (error, operation) => {
			if (finished || !enabled()) return;
			captureTelemetryError({
				...context,
				error,
				provider: options.provider,
				component: "authentication",
				operation,
				stage: "authentication",
			});
		},
		finish: (outcome) => {
			if (finished) return false;
			finished = true;
			unsubscribe();
			if (!enabled() || outcome !== "completed") return false;
			if (scope.providerCategory === "custom" || scope.providerCategory === "unknown") return true;
			const tracker = getTelemetryErrorRecoveryTracker(context.settingsManager, context.agentDir, {
				isEnabled: () => isTelemetryEnabled(context.settingsManager),
			});
			const pending = tracker.noteRecoveryAction("credentials_updated", scope);
			const updates = validated
				? tracker.finishErrors(
						pending.flatMap((properties) =>
							typeof properties.error_id === "string" ? [properties.error_id] : [],
						),
						scope,
					)
				: pending;
			for (const properties of updates) captureTelemetryEvent({ ...context, name: "agent error", properties });
			return true;
		},
	};
}
