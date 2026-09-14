import { join } from "node:path";
import { getDocsPath } from "../config.js";
import { classifyTelemetryError } from "./telemetry-error-classification.js";

const UNKNOWN_PROVIDER = "unknown";
export const LOGIN_RECOVERY_MESSAGE = "Run /login to update credentials.";

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

/**
 * Whether a model fallback message is the "no models available" warning.
 *
 * That warning is a claim about current state (no model could be resolved), so
 * consumers must re-check it against the live session before showing it; the
 * other fallback variants ("Could not restore model X. Using Y") are one-time
 * startup notices that stay valid.
 */
export function isNoModelsAvailableMessage(message: string | undefined): boolean {
	return message === formatNoModelsAvailableMessage();
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

export function formatAuthenticationFailedMessage(provider: string): string {
	return (
		`Authentication failed for "${provider}". Credentials may have expired or network is unavailable.\n\n` +
		LOGIN_RECOVERY_MESSAGE
	);
}

export function isLikelyAuthenticationError(message: string, evidence?: unknown): boolean {
	if (evidence !== undefined) {
		const classification = classifyTelemetryError(evidence);
		if (classification.classification_source !== "unknown") {
			return ["credential_invalid", "credential_expired", "credential_missing"].includes(
				classification.error_subtype,
			);
		}
	}
	return (
		/\b(401|403)\b/i.test(message) ||
		/unauthorized|forbidden|invalid[_ -]?api[_ -]?key|api key.*invalid/i.test(message) ||
		/authentication failed|invalid authentication|missing authentication/i.test(message) ||
		/(expired|invalid) token|token expired|access denied|permission denied/i.test(message)
	);
}

export function addLoginGuidanceToAuthError(message: string): string {
	if (/\/login\b/.test(message)) {
		return message;
	}
	return `${message}\n\n${LOGIN_RECOVERY_MESSAGE}`;
}
