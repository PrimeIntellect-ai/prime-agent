import { captureTelemetryEvent, isTelemetryEnabled } from "./telemetry.js";
import { telemetryProviderCategory } from "./telemetry-categories.js";
import type { TelemetryErrorOperation } from "./telemetry-error-classification.js";
import { getTelemetryErrorRecoveryTracker, type TelemetryRecoveryScope } from "./telemetry-error-recovery.js";
import type { TelemetryErrorContext } from "./telemetry-errors.js";
import { isTelemetryUuid } from "./telemetry-schema.js";
import { TelemetryScope } from "./telemetry-scope.js";

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
	if (!isTelemetryUuid(context.clientSessionId)) context.telemetryDisabled = true;
	const telemetry = new TelemetryScope(context);
	const attempt = telemetry.start();
	let validated = false;
	const scope: TelemetryRecoveryScope = {
		clientSessionId: context.clientSessionId,
		providerCategory: telemetryProviderCategory(options.provider),
		providerIdentity: options.provider,
		components: ["authentication"],
		operations: ["login", "validate"],
	};
	return {
		run: attempt.run,
		validation: (outcome) => {
			if (attempt.active()) validated = outcome === "completed";
		},
		reportError: (error, operation) => {
			attempt.error(error, {
				provider: options.provider,
				component: "authentication",
				operation,
				stage: "authentication",
			});
		},
		finish: (outcome) => {
			const captured = attempt.finish();
			telemetry.dispose();
			if (!captured || outcome !== "completed") return false;
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
