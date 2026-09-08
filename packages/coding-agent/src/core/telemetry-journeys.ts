import { randomUUID } from "node:crypto";
import type { AuthCredential, AuthStatus } from "./auth-storage.js";
import type { SettingsManager } from "./settings-manager.js";
import {
	captureTelemetryEvent,
	isTelemetryEnabled,
	type TelemetrySink,
	telemetryAuthCategory,
	telemetryProviderCategory,
} from "./telemetry.js";
import {
	clearOnboardingTelemetryContext,
	type OnboardingTelemetryContext,
	saveOnboardingTelemetryContext,
} from "./telemetry-journey-state.js";

export type TelemetryFeature =
	| "model"
	| "login"
	| "logout"
	| "effort"
	| "goal"
	| "new"
	| "resume"
	| "fork"
	| "clone"
	| "tree"
	| "feedback";
export type TelemetryFeatureOutcome = "completed" | "failed" | "canceled" | "unavailable";
export type TelemetryConfigurationChoice =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "create"
	| "status"
	| "pause"
	| "resume"
	| "clear"
	| "unknown";
export type TelemetryTaskFeedback = "helpful" | "partly_helpful" | "not_helpful";
export type TelemetryAcquisitionMethod =
	| "existing_configuration"
	| "prime_browser"
	| "prime_key_entry"
	| "oauth"
	| "api_key_entry"
	| "external_credentials"
	| "unknown";
export type TelemetryValidationScope =
	| "configuration"
	| "identity_scope"
	| "selected_context"
	| "inference"
	| "unchecked";
export type TelemetryOnboardingStage =
	| "entry"
	| "provider_selection"
	| "credential_discovery"
	| "credential_validation"
	| "model_access"
	| "ready"
	| "exit";
export type TelemetryStageOutcome =
	| "initiated"
	| "completed"
	| "failed"
	| "canceled"
	| "skipped"
	| "configured"
	| "unavailable"
	| "provider_switched";
export type TelemetryOnboardingEntryReason =
	| "first_setup"
	| "existing_configuration"
	| "previously_shown"
	| "reentered";

export interface TelemetryFeatureAttempt {
	finish(outcome: TelemetryFeatureOutcome, choice?: TelemetryConfigurationChoice): void;
}

export interface OnboardingStageObservation {
	provider?: string;
	authSource?: AuthStatus["source"];
	storedCredentialType?: AuthCredential["type"];
	acquisitionMethod?: TelemetryAcquisitionMethod;
	validationScope?: TelemetryValidationScope;
	durationMs?: number;
	systemWork?: boolean;
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
}

const DISABLED_FEATURE: TelemetryFeatureAttempt = { finish: () => {} };
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
	}

	private enabled(): boolean {
		if (this.disposed) return false;
		if (isTelemetryEnabled(this.options.settingsManager)) return true;
		this.clearMemory();
		clearOnboardingTelemetryContext(this.options.agentDir);
		return false;
	}

	beginFeature(feature: TelemetryFeature, choice?: TelemetryConfigurationChoice): TelemetryFeatureAttempt {
		if (!this.enabled()) return DISABLED_FEATURE;
		const generation = this.consentGeneration;
		const startedAt = this.now();
		const featureId = this.randomId();
		const previousSuccess = this.successfulFeatures.has(feature);
		const base = {
			feature_name: feature,
			feature_id: featureId,
			client_session_id: this.clientSessionId,
			previous_success: previousSuccess,
		};
		const capture = (outcome: "initiated" | TelemetryFeatureOutcome, configurationChoice = choice) => {
			if (!this.enabled() || generation !== this.consentGeneration) return;
			captureTelemetryEvent({
				...this.options,
				executionMode: "interactive",
				name: "agent feature outcome",
				properties: {
					...base,
					outcome,
					duration_ms: Math.max(0, this.now() - startedAt),
					...(configurationChoice ? { configuration_choice: configurationChoice } : {}),
				},
			});
		};
		capture("initiated");
		let finished = false;
		const attempt: TelemetryFeatureAttempt = {
			finish: (outcome, configurationChoice) => {
				if (finished || generation !== this.consentGeneration) return;
				finished = true;
				this.pendingFeatures.delete(attempt);
				capture(outcome, configurationChoice);
				if (outcome === "completed" && this.enabled() && generation === this.consentGeneration)
					this.successfulFeatures.add(feature);
			},
		};
		this.pendingFeatures.add(attempt);
		return attempt;
	}

	beginOnboarding(reason: TelemetryOnboardingEntryReason, persist = true): TelemetryOnboardingAttempt {
		if (!this.enabled()) return DISABLED_ONBOARDING;
		this.activeOnboarding?.finish("canceled");
		const generation = this.consentGeneration;
		const startedAt = this.now();
		const context: OnboardingTelemetryContext = {
			onboardingId: this.randomId(),
			clientSessionId: this.clientSessionId,
			startedAt: (this.options.wallNow ?? Date.now)(),
		};
		if (persist && this.enabled()) saveOnboardingTelemetryContext(this.options.agentDir, context);
		let finished = false;
		const attempt: TelemetryOnboardingAttempt = {
			context,
			stage: (stage, outcome, observation = {}) => {
				if (finished || !this.enabled() || generation !== this.consentGeneration) return;
				captureTelemetryEvent({
					...this.options,
					executionMode: "interactive",
					name: "onboarding stage",
					properties: {
						onboarding_id: context.onboardingId,
						client_session_id: context.clientSessionId,
						entry_reason: reason,
						stage,
						outcome,
						duration_ms: Math.max(0, observation.durationMs ?? this.now() - startedAt),
						timing_scope: observation.systemWork ? "system_work" : "elapsed_including_user_wait",
						provider_category: telemetryProviderCategory(observation.provider),
						auth_category: telemetryAuthCategory(observation.authSource, observation.storedCredentialType),
						acquisition_method: observation.acquisitionMethod ?? "unknown",
						validation_scope: observation.validationScope ?? "unchecked",
					},
				});
			},
			finish: (outcome, observation) => {
				if (finished) return;
				attempt.stage("exit", outcome, observation);
				finished = true;
				if (this.activeOnboarding === attempt) this.activeOnboarding = undefined;
			},
		};
		this.activeOnboarding = attempt;
		attempt.stage("entry", "initiated");
		return attempt;
	}

	startupStage(
		stage: "ui_ready" | "session_ui_rebind" | "configuration_load" | "credential_validation",
		outcome: "completed" | "failed",
		durationMs: number,
		startupKind: "cold" | "warm_attach" | "resumed" | "unknown" = "unknown",
		timingScope: "system_work" | "elapsed_including_user_wait" = "system_work",
	): void {
		if (!this.enabled()) return;
		captureTelemetryEvent({
			...this.options,
			executionMode: "interactive",
			name: "agent startup stage",
			properties: {
				client_session_id: this.clientSessionId,
				stage,
				outcome,
				duration_ms: Math.max(0, durationMs),
				startup_kind: startupKind,
				timing_scope: timingScope,
			},
		});
	}

	feedback(value: TelemetryTaskFeedback): void {
		if (!this.enabled()) return;
		captureTelemetryEvent({
			...this.options,
			executionMode: "interactive",
			name: "agent feature outcome",
			properties: {
				feature_name: "feedback",
				feature_id: this.randomId(),
				client_session_id: this.clientSessionId,
				outcome: "completed",
				feedback: value,
			},
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.unsubscribe();
		this.activeOnboarding?.finish("canceled");
		for (const attempt of this.pendingFeatures) attempt.finish("canceled");
		this.disposed = true;
		this.clearMemory();
	}
}
