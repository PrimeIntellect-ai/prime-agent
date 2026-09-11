import { randomUUID } from "node:crypto";
import type { AuthCredential, AuthStatus } from "./auth-storage.js";
import type { SettingsManager } from "./settings-manager.js";
import {
	captureTelemetryEvent,
	isTelemetryEnabled,
	type TelemetryEventName,
	type TelemetryProperties,
	type TelemetrySink,
	telemetryAuthCategory,
	telemetryProviderCategory,
} from "./telemetry.js";
import type { TELEMETRY_ENUMS } from "./telemetry-contract.js";
import {
	sanitizeTelemetryExecutionContext,
	type TelemetryExecutionContextCategories,
} from "./telemetry-execution-context.js";
import type { TelemetryInputMetadata, TelemetryInputRecoveryAction } from "./telemetry-input.js";
import {
	clearOnboardingTelemetryContext,
	getCurrentOnboardingTelemetryContext,
	type OnboardingTelemetryContext,
	saveOnboardingTelemetryContext,
} from "./telemetry-journey-state.js";

export type TelemetryFeature = (typeof TELEMETRY_ENUMS.feature)[number];
export type TelemetryFeatureOutcome = "completed" | "failed" | "canceled" | "unavailable";
export type TelemetryConfigurationChoice = (typeof TELEMETRY_ENUMS.configurationChoice)[number];
export type TelemetryTaskFeedback = (typeof TELEMETRY_ENUMS.feedback)[number];
export type TelemetryAcquisitionMethod = (typeof TELEMETRY_ENUMS.acquisitionMethod)[number];
export type TelemetryValidationScope = (typeof TELEMETRY_ENUMS.validationScope)[number];
export type TelemetryOnboardingStage = (typeof TELEMETRY_ENUMS.onboardingStage)[number];
export type TelemetryStageOutcome = (typeof TELEMETRY_ENUMS.onboardingOutcome)[number];
export type TelemetryOnboardingEntryReason = (typeof TELEMETRY_ENUMS.onboardingEntryReason)[number];

export interface TelemetryFeatureAttempt {
	finish(outcome: TelemetryFeatureOutcome, choice?: TelemetryConfigurationChoice): void;
}

export interface OnboardingStageObservation {
	setupContext?: TelemetryExecutionContextCategories;
	provider?: string;
	authSource?: AuthStatus["source"];
	storedCredentialType?: AuthCredential["type"];
	acquisitionMethod?: TelemetryAcquisitionMethod;
	validationScope?: TelemetryValidationScope;
	durationMs?: number;
	systemWork?: boolean;
}

export interface TelemetryUiInputAttempt {
	metadata?: TelemetryInputMetadata;
	admission(outcome: TelemetryFeatureOutcome): void;
	firstStatus(observed?: boolean, observedAt?: number): void;
}

export interface TelemetryOnboardingAttempt {
	context: OnboardingTelemetryContext;
	stage(
		stage: TelemetryOnboardingStage,
		outcome: TelemetryStageOutcome,
		observation?: OnboardingStageObservation,
	): void;
	finish(outcome: "completed" | "failed" | "canceled" | "skipped", observation?: OnboardingStageObservation): void;
}

interface TelemetryJourneysOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	sink?: TelemetrySink;
	now?: () => number;
	wallNow?: () => number;
	randomId?: () => string;
	onDisabled?: () => void;
}

const DISABLED_FEATURE: TelemetryFeatureAttempt = { finish: () => {} };
const DISABLED_INPUT: TelemetryUiInputAttempt = { admission: () => {}, firstStatus: () => {} };
const DISABLED_ONBOARDING: TelemetryOnboardingAttempt = {
	context: { onboardingId: "", clientSessionId: "", startedAt: 0 },
	stage: () => {},
	finish: () => {},
};

export class TelemetryJourneys {
	private clientSessionIdValue?: string;
	private consentGeneration = 0;
	private disposed = false;
	private readonly unsubscribe: () => void;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly successfulFeatures = new Set<TelemetryFeature>();
	private readonly pendingFeatures = new Set<TelemetryFeatureAttempt>();
	private activeOnboarding?: TelemetryOnboardingAttempt;
	private pendingRecoveryAction?: TelemetryInputRecoveryAction;
	private readonly pendingInputs = new Set<TelemetryUiInputAttempt>();

	constructor(private readonly options: TelemetryJourneysOptions) {
		this.now = options.now ?? (() => performance.now());
		this.randomId = options.randomId ?? randomUUID;
		this.unsubscribe = options.settingsManager.subscribeTelemetryEnabled(() => {
			this.enabled();
		});
		this.enabled();
	}

	get clientSessionId(): string {
		if (!this.enabled()) return "";
		this.clientSessionIdValue ??= this.randomId();
		return this.clientSessionIdValue;
	}

	private clearMemory(): void {
		this.consentGeneration++;
		this.clientSessionIdValue = undefined;
		this.activeOnboarding = undefined;
		this.pendingFeatures.clear();
		this.successfulFeatures.clear();
		this.pendingRecoveryAction = undefined;
		this.pendingInputs.clear();
		try {
			this.options.onDisabled?.();
		} catch {
			/* Consent changes cannot interrupt UI work. */
		}
	}

	private enabled(): boolean {
		if (this.disposed) return false;
		if (isTelemetryEnabled(this.options.settingsManager)) return true;
		this.clearMemory();
		clearOnboardingTelemetryContext(this.options.agentDir);
		return false;
	}

	private capture(name: TelemetryEventName, properties: TelemetryProperties): void {
		if (!this.enabled()) return;
		captureTelemetryEvent({
			...this.options,
			executionMode: "interactive",
			name,
			properties: { client_session_id: this.clientSessionId, ...properties },
		});
	}

	private start(properties: TelemetryProperties, startedAt = this.now()) {
		const generation = this.consentGeneration;
		const context = { client_session_id: this.clientSessionId, ...properties };
		let finished = false;
		const current = () => this.enabled() && generation === this.consentGeneration;
		const active = () => !finished && current();
		const record = (name: TelemetryEventName, fields: TelemetryProperties, at = this.now(), terminal = false) => {
			if (!active()) return false;
			finished = terminal;
			this.capture(name, { ...context, duration_ms: Math.max(0, at - startedAt), ...fields });
			return current();
		};
		return {
			active,
			record,
			finish: (name: TelemetryEventName, fields: TelemetryProperties, at?: number) => record(name, fields, at, true),
		};
	}

	beginFeature(feature: TelemetryFeature, choice?: TelemetryConfigurationChoice): TelemetryFeatureAttempt {
		if (!this.enabled()) return DISABLED_FEATURE;
		const startedAt = this.now();
		const operation = this.start(
			{
				feature_name: feature,
				feature_id: this.randomId(),
				previous_success: this.successfulFeatures.has(feature),
				...(choice ? { configuration_choice: choice } : {}),
			},
			startedAt,
		);
		operation.record("agent feature outcome", { outcome: "initiated" });
		const attempt: TelemetryFeatureAttempt = {
			finish: (outcome, configurationChoice = choice) => {
				this.pendingFeatures.delete(attempt);
				const captured = operation.finish("agent feature outcome", {
					outcome,
					...(configurationChoice ? { configuration_choice: configurationChoice } : {}),
				});
				if (captured && outcome === "completed") this.successfulFeatures.add(feature);
			},
		};
		this.pendingFeatures.add(attempt);
		return attempt;
	}

	beginOnboarding(reason: TelemetryOnboardingEntryReason, persist = true): TelemetryOnboardingAttempt {
		if (!this.enabled()) return DISABLED_ONBOARDING;
		this.activeOnboarding?.finish("canceled");
		const startedAt = this.now();
		const context: OnboardingTelemetryContext = {
			onboardingId: this.randomId(),
			clientSessionId: this.clientSessionId,
			startedAt: (this.options.wallNow ?? Date.now)(),
		};
		const operation = this.start({ onboarding_id: context.onboardingId, entry_reason: reason }, startedAt);
		if (persist && operation.active()) saveOnboardingTelemetryContext(this.options.agentDir, context);
		const stage = (
			stage: TelemetryOnboardingStage,
			outcome: TelemetryStageOutcome,
			observation: OnboardingStageObservation = {},
			terminal = false,
		) => {
			const capture = terminal ? operation.finish : operation.record;
			capture("onboarding stage", {
				stage,
				outcome,
				...(observation.durationMs !== undefined ? { duration_ms: Math.max(0, observation.durationMs) } : {}),
				timing_scope: observation.systemWork ? "system_work" : "elapsed_including_user_wait",
				provider_category: telemetryProviderCategory(observation.provider),
				auth_category: telemetryAuthCategory(observation.authSource, observation.storedCredentialType),
				acquisition_method: observation.acquisitionMethod ?? "unknown",
				validation_scope: observation.validationScope ?? "unchecked",
			});
		};
		const attempt: TelemetryOnboardingAttempt = {
			context,
			stage,
			finish: (outcome, observation) => {
				if (!operation.active()) return;
				if (persist && observation?.setupContext) {
					context.setupContext = sanitizeTelemetryExecutionContext(observation.setupContext);
					saveOnboardingTelemetryContext(this.options.agentDir, context);
				}
				stage("exit", outcome, observation, true);
				if (this.activeOnboarding === attempt) this.activeOnboarding = undefined;
			},
		};
		this.activeOnboarding = attempt;
		attempt.stage("entry", "initiated");
		return attempt;
	}

	noteRecoveryAction(action: TelemetryInputRecoveryAction): void {
		if (this.enabled()) this.pendingRecoveryAction = action;
	}

	beginInput(uiContext?: TelemetryExecutionContextCategories): TelemetryUiInputAttempt {
		if (!this.enabled()) return DISABLED_INPUT;
		const startedAt = this.now();
		const onboarding = getCurrentOnboardingTelemetryContext(
			this.options.agentDir,
			(this.options.wallNow ?? Date.now)(),
		);
		const recoveryAction = this.pendingRecoveryAction;
		this.pendingRecoveryAction = undefined;
		const metadata: TelemetryInputMetadata = {
			inputId: this.randomId(),
			clientSessionId: this.clientSessionId,
			...(onboarding ? { onboardingId: onboarding.onboardingId, setupContext: onboarding.setupContext } : {}),
			...(uiContext ? { uiContext: sanitizeTelemetryExecutionContext(uiContext) } : {}),
			...(recoveryAction ? { recoveryAction } : {}),
		};
		const operation = this.start(
			{
				input_id: metadata.inputId,
				...(metadata.onboardingId ? { onboarding_id: metadata.onboardingId } : {}),
				timing_origin: "ui_input",
			},
			startedAt,
		);
		operation.record("agent input stage", { stage: "submitted", outcome: "initiated" });
		let admitted = false;
		let statusObserved = false;
		const attempt: TelemetryUiInputAttempt = {
			get metadata() {
				return operation.active() ? metadata : undefined;
			},
			admission: (outcome) => {
				if (admitted) return;
				admitted = true;
				if (statusObserved) this.pendingInputs.delete(attempt);
				operation.record("agent input stage", {
					stage: outcome === "completed" ? "admitted" : "rejected",
					outcome,
				});
				if (outcome !== "completed") {
					if (operation.active() && recoveryAction && !this.pendingRecoveryAction)
						this.pendingRecoveryAction = recoveryAction;
					attempt.firstStatus(false);
				}
			},
			firstStatus: (observed = true, observedAt) => {
				if (statusObserved) return;
				statusObserved = true;
				if (admitted) this.pendingInputs.delete(attempt);
				operation.record(
					"agent timing",
					{
						stage: "first_status",
						outcome: observed ? "completed" : "unavailable",
						...(!observed ? { duration_ms: null } : {}),
					},
					observedAt,
				);
			},
		};
		this.pendingInputs.add(attempt);
		return attempt;
	}

	beginCancellation(): (outcome: TelemetryFeatureOutcome, observedAt?: number) => void {
		if (!this.enabled()) return () => {};
		const operation = this.start({ stage: "cancellation_to_idle", timing_origin: "ui_cancellation" });
		return (outcome, observedAt) => {
			operation.finish(
				"agent timing",
				{
					outcome,
					...(outcome !== "completed" ? { duration_ms: null } : {}),
				},
				observedAt,
			);
		};
	}

	startupStage(
		stage: "ui_ready" | "session_ui_rebind" | "configuration_load" | "credential_validation",
		outcome: "completed" | "failed",
		durationMs: number,
		startupKind: "cold" | "warm_attach" | "resumed" | "unknown" = "unknown",
		timingScope: "system_work" | "elapsed_including_user_wait" = "system_work",
	): void {
		this.capture("agent startup stage", {
			stage,
			outcome,
			duration_ms: Math.max(0, durationMs),
			startup_kind: startupKind,
			timing_scope: timingScope,
		});
	}

	feedback(value: TelemetryTaskFeedback): void {
		if (!this.enabled()) return;
		this.capture("agent feature outcome", {
			feature_name: "feedback",
			feature_id: this.randomId(),
			outcome: "completed",
			feedback: value,
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.unsubscribe();
		this.activeOnboarding?.finish("canceled");
		for (const attempt of this.pendingFeatures) attempt.finish("canceled");
		for (const attempt of this.pendingInputs) {
			attempt.admission("canceled");
			attempt.firstStatus(false);
		}
		this.disposed = true;
		this.clearMemory();
	}
}
