import { join } from "node:path";
import { getDocsPath } from "../config.js";

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

/**
 * Image-attaching turns on a model without image input must not silently drop
 * the images: name the session model, the setting, and the alternatives so the
 * user can act immediately.
 */
export function formatImageModelRequiredMessage(sessionModelId: string): string {
	return [
		`This turn attaches images, but the selected model (${sessionModelId}) does not accept image input.`,
		"",
		"Pick one:",
		`- Switch the session model to an image-capable one with /model, or`,
		`- Set an image model for this session with /image-model <model>, or`,
		`- Set imageModel in settings.json to an image-capable model ("provider/model-id" or a bare id), e.g. "anthropic/claude-sonnet-4-5"`,
		"",
		"Then resend the message. Without it the request would silently drop the images.",
	].join("\n");
}

export function formatImageModelUnusableMessage(reference: string): string {
	return [
		`imageModel "${reference}" could not be resolved to an available, image-capable, authenticated model.`,
		"",
		"Fix it with /image-model (this session) or the imageModel setting (settings.json), and authenticate the provider, then resend the message.",
	].join("\n");
}

/**
 * settings.images.blockImages stops every image from reaching a provider, so a
 * delegated read cannot run either: name the setting that blocks it instead of
 * the model setting that is not the problem.
 */
export function formatBlockedImagesMessage(): string {
	return [
		"Image attachments are blocked (images.blockImages in settings.json), so this image cannot be read.",
		"",
		"Set images.blockImages to false, then retry.",
	].join("\n");
}

/**
 * Why an explicit image-model reference could not serve image turns. The three
 * causes need different fixes, so `/image-model` reports the specific one
 * instead of the generic routing message above.
 */
export type ImageModelReferenceProblem = "unresolved" | "text-only" | "unauthenticated" | "not-available";

const IMAGE_MODEL_REFERENCE_PROBLEM_MESSAGES: Record<ImageModelReferenceProblem, (reference: string) => string> = {
	unresolved: (reference) =>
		`No model matches "${reference}". Use "provider/model-id" or a bare id, or browse models with /model.`,
	"text-only": (reference) => `"${reference}" does not accept image input, so it cannot serve image turns.`,
	unauthenticated: (reference) =>
		`"${reference}" has no configured credentials. Authenticate its provider with /login, then retry.`,
	// Credentials are not the problem here, so this must not send the user to
	// /login: the model exists with working auth and only the available list is
	// missing it.
	"not-available": (reference) =>
		`"${reference}" is not available to this session, so it cannot serve image turns. Its provider is authenticated, but the model is missing from the available model list (a private Prime Inference model the team is not entitled to, for example). Pick an available image model with /model.`,
};

export function formatImageModelReferenceRejectedMessage(
	reference: string,
	problem: ImageModelReferenceProblem,
): string {
	return IMAGE_MODEL_REFERENCE_PROBLEM_MESSAGES[problem](reference);
}

/**
 * The image-turn child never answered. The images are still unread, so the turn
 * is stopped and the setting that picks the image model is named as the fix.
 */
export function formatImageTurnChildTimeoutMessage(reference: string, timeoutMs: number): string {
	return [
		`The image model "${reference}" did not finish reading the attached image(s) within ${Math.round(timeoutMs / 1000)}s, so the turn was stopped before the images reached a model that cannot see them.`,
		"",
		"Retry, or point the image model at a faster model with /image-model (or imageModel in settings.json).",
	].join("\n");
}

export function isLikelyAuthenticationError(message: string): boolean {
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
