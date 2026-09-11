import type { AuthCredential, AuthStatus } from "./auth-storage.js";

export type TelemetryAuthCategory =
	| "oauth"
	| "api_key"
	| "runtime_api_key"
	| "environment"
	| "prime_cli"
	| "models_json"
	| "fallback"
	| "stale"
	| "stored"
	| "none";

export const TELEMETRY_PROVIDER_CATEGORIES = [
	"anthropic",
	"openai",
	"google",
	"prime",
	"openrouter",
	"bedrock",
	"vertex",
	"mistral",
	"groq",
	"xai",
] as const;
export const TELEMETRY_MODEL_CATEGORIES = [
	"claude",
	"gpt",
	"o1",
	"o3",
	"o4",
	"gemini",
	"glm",
	"kimi",
	"qwen",
	"deepseek",
	"llama",
	"mistral",
] as const;
export const TELEMETRY_AUTH_CATEGORIES = [
	"oauth",
	"api_key",
	"runtime_api_key",
	"environment",
	"prime_cli",
	"models_json",
	"fallback",
	"stale",
	"stored",
	"none",
] as const;

export function telemetryModelCategory(model: string): string {
	const normalized = model.toLowerCase();
	return TELEMETRY_MODEL_CATEGORIES.find((category) => normalized.includes(category)) ?? "custom";
}

export function telemetryProviderCategory(provider: string | undefined): string {
	if (!provider) return "unknown";
	const normalized = provider.toLowerCase();
	return TELEMETRY_PROVIDER_CATEGORIES.find((category) => normalized.includes(category)) ?? "custom";
}

export function telemetryAuthCategory(
	source: AuthStatus["source"],
	storedCredentialType?: AuthCredential["type"],
): TelemetryAuthCategory {
	switch (source) {
		case "stored":
			return storedCredentialType ?? "stored";
		case "runtime":
			return "runtime_api_key";
		case "environment":
			return "environment";
		case "prime_cli":
			return "prime_cli";
		case "models_json_key":
		case "models_json_command":
			return "models_json";
		case "fallback":
			return "fallback";
		case "stale":
			return "stale";
		default:
			return "none";
	}
}
