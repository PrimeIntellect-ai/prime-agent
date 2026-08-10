/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	type AnthropicMessagesCompat,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type OAuthProviderInterface,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { type Static, type TProperties, Type } from "typebox";
import type { Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { getAgentDir, VERSION } from "../config.js";
import type { AuthSourceToken, AuthStatus, AuthStorage } from "./auth-storage.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "./prime-inference-auth.js";
import {
	fetchAuthorizedPrivatePrimeInferenceModelIds,
	getPrivatePrimeInferenceModels,
	isPrivatePrimeInferenceModel,
} from "./prime-inference-models.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";
import {
	clearConfigValueCache,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.js";

// Schema for OpenRouter routing preferences
const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for thinking level support and provider-specific values
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
	max: Type.Optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	sendSessionIdHeader: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

// Schema for per-model overrides (all fields optional, merged with built-in model)
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

// typebox/compile costs ~300ms to import, so the models.json validator loads
// lazily. The first load of an existing models.json proceeds on JSON parsing +
// validateConfig() and reports schema errors asynchronously once the validator
// is ready; subsequent refreshes validate synchronously.
let validateModelsConfig: Validator<TProperties, typeof ModelsConfigSchema> | undefined;
let modelsValidatorPromise: Promise<void> | undefined;

function preloadModelsConfigValidator(): Promise<void> {
	modelsValidatorPromise ??= import("typebox/compile").then(({ Compile }) => {
		validateModelsConfig = Compile(ModelsConfigSchema);
	});
	return modelsValidatorPromise;
}

type ModelsConfig = Static<typeof ModelsConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Provider override config (baseUrl, compat) without request auth/headers */
interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

type ProviderRequestAuthSource = {
	source: "environment" | "models_json_key" | "models_json_command";
	configured: true;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	resolveValueFingerprint?: () => string | undefined;
};

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export interface ModelCatalogSnapshot {
	models: Model<Api>[];
	configuredProviders: string[];
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	/** Providers with baseUrl/headers/apiKey overrides for built-in models */
	overrides: Map<string, ProviderOverride>;
	/** Per-model overrides: provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// Merge cost (partial override)
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	// Deep merge compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

function readOpenAICodexAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		};
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function openAICodexModelsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	let path: string;
	if (normalized.endsWith("/codex/responses")) {
		path = `${normalized.slice(0, -"/responses".length)}/models`;
	} else if (normalized.endsWith("/codex")) {
		path = `${normalized}/models`;
	} else {
		path = `${normalized}/codex/models`;
	}
	const url = new URL(path);
	url.searchParams.set("client_version", VERSION);
	return url.toString();
}

function readOpenAICodexModelIds(value: unknown): Set<string> {
	if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
		throw new Error("Invalid OpenAI Codex model catalog");
	}
	return new Set(
		value.models.flatMap((model) => {
			if (!model || typeof model !== "object" || !("slug" in model) || typeof model.slug !== "string") {
				return [];
			}
			return [model.slug];
		}),
	);
}

const PRIVATE_PRIME_AUTHORIZATION_CACHE_FILE = "prime-inference-private-models.json";
const PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS = 5 * 60_000;
const PRIVATE_PRIME_BACKGROUND_REFRESH_TIMEOUT_MS = 3_000;

interface PrivatePrimeAuthorizationCache {
	fingerprint: string;
	modelIds: Set<string>;
	refreshedAt: number;
}

function privatePrimeAuthorizationFingerprint(apiKey: string, teamId: string): string {
	return createHash("sha256").update(apiKey).update("\0").update(teamId).digest("hex");
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private staleProviderRequestAuthSources: Map<string, AuthSourceToken[]> = new Map();
	private lastProviderAuthSourceTokens: Map<string, AuthSourceToken> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private authorizedPrivatePrimeInferenceModelIds = new Set<string>();
	private authorizedPrivatePrimeInferenceTeamId: string | undefined;
	private explicitPrivatePrimeInferenceModelIds = new Set<string>();
	private openAICodexModelsCache: { authFingerprint: string; modelIds: Set<string>; refreshedAt: number } | undefined;
	private backgroundPrivatePrimeAuthorization: { fingerprint: string; promise: Promise<void> } | undefined;
	private loadError: string | undefined = undefined;

	/** Re-register dynamic OAuth providers (e.g. user MCP servers) after refresh() resets the registry. */
	private onOAuthProvidersReset?: () => void;

	private constructor(
		readonly authStorage: AuthStorage,
		private modelsJsonPath: string | undefined,
	) {
		this.loadModels();
	}

	setOnOAuthProvidersReset(hook: () => void): void {
		this.onOAuthProvidersReset = hook;
	}

	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		return new ModelRegistry(authStorage, modelsJsonPath);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, undefined);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.lastProviderAuthSourceTokens.clear();
		this.authorizedPrivatePrimeInferenceModelIds.clear();
		this.authorizedPrivatePrimeInferenceTeamId = undefined;
		this.explicitPrivatePrimeInferenceModelIds.clear();
		this.loadError = undefined;

		// Credentials may have been written by another process (e.g. the UI
		// process saving a login while the session lives in the daemon).
		this.authStorage.reload();

		// Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
		resetApiProviders();
		resetOAuthProviders();
		// reset drops everything but model-provider built-ins; re-add MCP integrations
		// (built-in catalog + this session's user-declared servers via the hook).
		// NOTE: the OAuth registry is process-global. Built-in MCP providers are
		// identical across sessions so they always survive; a user-declared server
		// unique to another daemon session is dropped here and re-registered on that
		// session's next refresh. Fully isolating it would require a session-scoped
		// registry in pi-ai (out of scope here).
		registerBuiltinMcpOAuthProviders();
		this.onOAuthProvidersReset?.();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		// Load custom models and overrides from models.json
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			// Keep built-in models even if custom models failed to load
		}

		this.explicitPrivatePrimeInferenceModelIds = new Set(
			customModels.filter(isPrivatePrimeInferenceModel).map((model) => model.id),
		);
		const builtInModels = [...this.loadBuiltInModels(overrides, modelOverrides), ...getPrivatePrimeInferenceModels()];
		let combined = this.mergeCustomModels(builtInModels, customModels);

		// Let OAuth providers modify their models (e.g., update baseUrl)
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			const cred = this.authStorage.get(oauthProvider.id);
			if (cred?.type === "oauth" && oauthProvider.modifyModels) {
				combined = oauthProvider.modifyModels(combined, cred);
			}
		}

		this.models = combined;
	}

	/** Load built-in models and apply provider/model overrides */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as KnownProvider) as Model<Api>[];
			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// Apply provider-level baseUrl/headers/compat override
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model override
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	/** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const parsed = JSON.parse(stripJsonComments(content)) as unknown;

			if (!validateModelsConfig) {
				// Validator not loaded yet (first refresh during startup): proceed on
				// validateConfig() below and report schema errors asynchronously once
				// the validator is ready. Later refreshes validate synchronously.
				void preloadModelsConfigValidator().then(() => {
					if (validateModelsConfig && !validateModelsConfig.Check(parsed)) {
						const errors =
							validateModelsConfig
								.Errors(parsed)
								.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
								.join("\n") || "Unknown schema error";
						console.error(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
					}
				});
			} else if (!validateModelsConfig.Check(parsed)) {
				const errors =
					validateModelsConfig
						.Errors(parsed)
						.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
						.join("\n") || "Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			const config = parsed as ModelsConfig;

			// Additional validation
			this.validateConfig(config);

			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				if (providerConfig.baseUrl || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						compat: providerConfig.compat,
					});
				}

				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
					}
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		const builtInProviders = new Set<string>(getProviders());

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const isBuiltIn = builtInProviders.has(providerName);
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides =
				providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// Override-only config: needs baseUrl, headers, compat, modelOverrides, or some combination.
				if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
					);
				}
			} else if (!isBuiltIn) {
				// Non-built-in providers with custom models require endpoint + auth.
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
				if (!providerConfig.apiKey) {
					throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
				}
			}
			// Built-in providers with custom models: baseUrl/apiKey/api are optional,
			// inherited from built-in models. Auth comes from env vars / auth storage.

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;

				if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}
				// For built-in providers, api is optional — inherited from built-in models.

				if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
				// Validate contextWindow/maxTokens only if provided (they have defaults)
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getProviders());

		// Cache built-in defaults (api, baseUrl) per provider, extracted from first model.
		const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
		const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
			const builtIn = getModels(providerName as KnownProvider) as Model<Api>[];
			if (builtIn.length === 0) return undefined;
			const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				const compat = mergeCompat(providerConfig.compat, modelDef.compat);
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: undefined,
					compat,
				} as Model<Api>);
			}
		}

		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.models.filter((model) => {
			if (
				isPrivatePrimeInferenceModel(model) &&
				!this.explicitPrivatePrimeInferenceModelIds.has(model.id) &&
				!this.authorizedPrivatePrimeInferenceModelIds.has(model.id)
			) {
				return false;
			}
			return this.hasConfiguredAuth(model);
		});
	}

	async refreshAvailableModels(): Promise<Model<Api>[]> {
		const previousPrivateModelIds = new Set(this.authorizedPrivatePrimeInferenceModelIds);
		const previousTeamId = this.authorizedPrivatePrimeInferenceTeamId;
		this.refresh();
		await this.refreshPrivatePrimeInferenceAuthorization(previousPrivateModelIds, previousTeamId);
		return this.getAvailable();
	}

	private async refreshPrivatePrimeInferenceAuthorization(
		previousPrivateModelIds = new Set(this.authorizedPrivatePrimeInferenceModelIds),
		previousTeamId = this.authorizedPrivatePrimeInferenceTeamId,
	): Promise<void> {
		const apiKey = await this.authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID);
		const teamHeaders = this.authStorage.getProviderHeaders(PRIME_INFERENCE_PROVIDER_ID);
		const teamId = teamHeaders?.["X-Prime-Team-ID"];
		if (!apiKey || !teamHeaders || !teamId) {
			this.authorizedPrivatePrimeInferenceModelIds.clear();
			this.authorizedPrivatePrimeInferenceTeamId = undefined;
			return;
		}

		const fingerprint = privatePrimeAuthorizationFingerprint(apiKey, teamId);
		const cached = this.readPrivatePrimeAuthorizationCache();
		if (cached?.fingerprint === fingerprint) {
			// Serve the persisted authorization decision so startup and model lists
			// don't block on the network. A stale cache refreshes in the background
			// and the updated ids apply to subsequent lookups in this process.
			this.authorizedPrivatePrimeInferenceModelIds = new Set(cached.modelIds);
			this.authorizedPrivatePrimeInferenceTeamId = teamId;
			const cacheIsFresh = Date.now() - cached.refreshedAt < PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS;
			if (cacheIsFresh || isOfflineModeEnabled()) {
				return;
			}
			this.startBackgroundPrivatePrimeAuthorizationRefresh(apiKey, teamHeaders, teamId, fingerprint);
			return;
		}
		if (isOfflineModeEnabled()) {
			this.authorizedPrivatePrimeInferenceModelIds.clear();
			this.authorizedPrivatePrimeInferenceTeamId = undefined;
			return;
		}

		let authorizedIds: Set<string> | undefined;
		try {
			authorizedIds = await fetchAuthorizedPrivatePrimeInferenceModelIds(apiKey, teamHeaders);
		} catch {
			// Fall back to the previous authorization below.
		}
		// Leave newer state untouched if the credentials changed while fetching.
		if ((await this.currentPrivatePrimeAuthorizationFingerprint()) !== fingerprint) {
			return;
		}
		if (authorizedIds) {
			this.authorizedPrivatePrimeInferenceModelIds = authorizedIds;
			this.authorizedPrivatePrimeInferenceTeamId = teamId;
			this.writePrivatePrimeAuthorizationCache({ fingerprint, modelIds: authorizedIds, refreshedAt: Date.now() });
		} else if (teamId === previousTeamId) {
			this.authorizedPrivatePrimeInferenceModelIds = previousPrivateModelIds;
			this.authorizedPrivatePrimeInferenceTeamId = teamId;
		} else {
			this.authorizedPrivatePrimeInferenceModelIds.clear();
			this.authorizedPrivatePrimeInferenceTeamId = undefined;
		}
	}

	/**
	 * Stale cache hits refresh in the background; failures keep the cached ids.
	 * Refreshes for the same credentials are deduped, a changed-credentials
	 * refresh is queued after the in-flight one, and a result is only applied
	 * if the credentials it was fetched with are still current.
	 */
	private startBackgroundPrivatePrimeAuthorizationRefresh(
		apiKey: string,
		teamHeaders: Record<string, string>,
		teamId: string,
		fingerprint: string,
	): void {
		if (this.backgroundPrivatePrimeAuthorization?.fingerprint === fingerprint) {
			return;
		}
		const run = async () => {
			try {
				const authorizedIds = await fetchAuthorizedPrivatePrimeInferenceModelIds(
					apiKey,
					teamHeaders,
					undefined,
					PRIVATE_PRIME_BACKGROUND_REFRESH_TIMEOUT_MS,
				);
				if ((await this.currentPrivatePrimeAuthorizationFingerprint()) !== fingerprint) {
					return;
				}
				this.authorizedPrivatePrimeInferenceModelIds = authorizedIds;
				this.authorizedPrivatePrimeInferenceTeamId = teamId;
				this.writePrivatePrimeAuthorizationCache({ fingerprint, modelIds: authorizedIds, refreshedAt: Date.now() });
			} catch {
				// Keep the cached ids.
			}
		};
		const pending = this.backgroundPrivatePrimeAuthorization?.promise;
		const promise = (pending ?? Promise.resolve()).then(run);
		this.backgroundPrivatePrimeAuthorization = { fingerprint, promise };
		void promise.finally(() => {
			if (this.backgroundPrivatePrimeAuthorization?.promise === promise) {
				this.backgroundPrivatePrimeAuthorization = undefined;
			}
		});
	}

	private async currentPrivatePrimeAuthorizationFingerprint(): Promise<string | undefined> {
		const apiKey = await this.authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID);
		const teamId = this.authStorage.getProviderHeaders(PRIME_INFERENCE_PROVIDER_ID)?.["X-Prime-Team-ID"];
		return apiKey && teamId ? privatePrimeAuthorizationFingerprint(apiKey, teamId) : undefined;
	}

	private privatePrimeAuthorizationCachePath(): string | undefined {
		if (!this.modelsJsonPath) {
			return undefined;
		}
		return join(dirname(this.modelsJsonPath), PRIVATE_PRIME_AUTHORIZATION_CACHE_FILE);
	}

	private readPrivatePrimeAuthorizationCache(): PrivatePrimeAuthorizationCache | undefined {
		const cachePath = this.privatePrimeAuthorizationCachePath();
		if (!cachePath) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<
				Omit<PrivatePrimeAuthorizationCache, "modelIds"> & { modelIds: string[] }
			>;
			if (
				typeof parsed.fingerprint !== "string" ||
				!Array.isArray(parsed.modelIds) ||
				typeof parsed.refreshedAt !== "number"
			) {
				return undefined;
			}
			return {
				fingerprint: parsed.fingerprint,
				modelIds: new Set(parsed.modelIds),
				refreshedAt: parsed.refreshedAt,
			};
		} catch {
			return undefined;
		}
	}

	private writePrivatePrimeAuthorizationCache(cache: PrivatePrimeAuthorizationCache): void {
		const cachePath = this.privatePrimeAuthorizationCachePath();
		if (!cachePath) {
			return;
		}
		try {
			const tmpPath = `${cachePath}.${process.pid}.tmp`;
			writeFileSync(tmpPath, JSON.stringify({ ...cache, modelIds: [...cache.modelIds] }), { mode: 0o600 });
			renameSync(tmpPath, cachePath);
		} catch {
			// Caching is best effort; a failed write just means the next startup refetches.
		}
	}

	async refreshModelCatalog(): Promise<ModelCatalogSnapshot> {
		const availableModels = await this.refreshAvailableModels();
		const availablePrivateModels = new Set(
			availableModels.filter(isPrivatePrimeInferenceModel).map((model) => `${model.provider}/${model.id}`),
		);
		return {
			models: this.models.filter(
				(model) =>
					!isPrivatePrimeInferenceModel(model) || availablePrivateModels.has(`${model.provider}/${model.id}`),
			),
			configuredProviders: [...new Set(availableModels.map((model) => model.provider))],
		};
	}

	async canUseModel(model: Model<Api>): Promise<boolean> {
		if (!this.hasConfiguredAuth(model)) {
			return false;
		}
		if (!isPrivatePrimeInferenceModel(model)) {
			return true;
		}

		const availableModels = await this.refreshAvailableModels();
		return availableModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
	}

	async getExecutableModels(): Promise<Model<Api>[]> {
		await this.refreshPrivatePrimeInferenceAuthorization();
		const availableModels = this.getAvailable();
		const codexModels = availableModels.filter((model) => model.provider === "openai-codex");
		if (codexModels.length === 0) {
			return availableModels;
		}

		const auth = await this.getApiKeyAndHeaders(codexModels[0]!);
		if (!auth.ok || !auth.apiKey) {
			return availableModels.filter((model) => model.provider !== "openai-codex");
		}
		const authFingerprint = createHash("sha256").update(auth.apiKey).digest("hex");
		const cached = this.openAICodexModelsCache;
		if (cached?.authFingerprint === authFingerprint && Date.now() - cached.refreshedAt < 300_000) {
			return availableModels.filter((model) => model.provider !== "openai-codex" || cached.modelIds.has(model.id));
		}

		const accountId = readOpenAICodexAccountId(auth.apiKey);
		if (!accountId) {
			return availableModels.filter((model) => model.provider !== "openai-codex");
		}
		try {
			const response = await fetch(openAICodexModelsUrl(codexModels[0]!.baseUrl), {
				headers: {
					...auth.headers,
					Authorization: `Bearer ${auth.apiKey}`,
					"chatgpt-account-id": accountId,
					originator: "pi",
				},
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) {
				throw new Error(`OpenAI Codex model discovery failed with HTTP ${response.status}`);
			}
			const modelIds = readOpenAICodexModelIds(await response.json());
			this.openAICodexModelsCache = { authFingerprint, modelIds, refreshedAt: Date.now() };
			return availableModels.filter((model) => model.provider !== "openai-codex" || modelIds.has(model.id));
		} catch {
			if (cached?.authFingerprint === authFingerprint && Date.now() - cached.refreshedAt < 300_000) {
				return availableModels.filter(
					(model) => model.provider !== "openai-codex" || cached.modelIds.has(model.id),
				);
			}
			return availableModels.filter((model) => model.provider !== "openai-codex");
		}
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.authStorage.hasAuth(model.provider) || this.hasConfiguredProviderRequestAuth(model.provider);
	}

	private fingerprintProviderRequestAuthSource(source: ProviderRequestAuthSource["source"], material: string): string {
		const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
		return `${source}:${digest}`;
	}

	private createProviderRequestAuthSource(options: {
		source: ProviderRequestAuthSource["source"];
		identityMaterial: string;
		valueMaterial?: string;
		label?: string;
		resolveValueMaterial?: () => string | undefined;
	}): ProviderRequestAuthSource {
		return {
			configured: true,
			source: options.source,
			...(options.label ? { label: options.label } : {}),
			identityFingerprint: this.fingerprintProviderRequestAuthSource(
				options.source,
				`identity:${options.identityMaterial}`,
			),
			...(options.valueMaterial !== undefined
				? {
						valueFingerprint: this.fingerprintProviderRequestAuthSource(
							options.source,
							`value:${options.identityMaterial}\0${options.valueMaterial}`,
						),
					}
				: {}),
			...(options.resolveValueMaterial
				? {
						resolveValueFingerprint: () => {
							const valueMaterial = options.resolveValueMaterial?.();
							return valueMaterial === undefined
								? undefined
								: this.fingerprintProviderRequestAuthSource(
										options.source,
										`value:${options.identityMaterial}\0${valueMaterial}`,
									);
						},
					}
				: {}),
		};
	}

	private getProviderRequestAuthSource(
		provider: string,
		options?: { resolvedApiKey?: string },
	): ProviderRequestAuthSource | undefined {
		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			return undefined;
		}

		if (providerApiKey.startsWith("!")) {
			return this.createProviderRequestAuthSource({
				source: "models_json_command",
				identityMaterial: providerApiKey,
				valueMaterial:
					options?.resolvedApiKey === undefined ? undefined : `${providerApiKey}\0${options.resolvedApiKey}`,
				resolveValueMaterial: () => {
					const resolved = resolveConfigValueUncached(providerApiKey);
					return resolved === undefined ? undefined : `${providerApiKey}\0${resolved}`;
				},
			});
		}

		const envValue = process.env[providerApiKey];
		if (envValue) {
			return this.createProviderRequestAuthSource({
				source: "environment",
				label: providerApiKey,
				identityMaterial: providerApiKey,
				valueMaterial: `${providerApiKey}\0${envValue}`,
			});
		}

		return this.createProviderRequestAuthSource({
			source: "models_json_key",
			identityMaterial: provider,
			valueMaterial: providerApiKey,
		});
	}

	private isProviderRequestAuthStale(provider: string, source: ProviderRequestAuthSource): boolean {
		const matchingStale = this.getMatchingStaleProviderRequestAuthSources(provider, source);
		if (matchingStale.length === 0) {
			return false;
		}
		const valueFingerprint = source.valueFingerprint ?? source.resolveValueFingerprint?.();
		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
	}

	private isProviderRequestAuthStaleForStatus(provider: string, source: ProviderRequestAuthSource): boolean {
		const matchingStale = this.getMatchingStaleProviderRequestAuthSources(provider, source);
		if (matchingStale.length === 0) {
			return false;
		}
		if (!source.valueFingerprint) {
			return true;
		}
		const isStale = matchingStale.some((token) => token.valueFingerprint === source.valueFingerprint);
		if (!isStale) {
			this.clearStaleProviderRequestAuthSource(provider, source);
		}
		return isStale;
	}

	private getMatchingStaleProviderRequestAuthSources(
		provider: string,
		source: ProviderRequestAuthSource,
	): AuthSourceToken[] {
		const stale = this.staleProviderRequestAuthSources.get(provider);
		if (!stale) {
			return [];
		}
		return stale.filter(
			(token) => token.source === source.source && token.identityFingerprint === source.identityFingerprint,
		);
	}

	private clearStaleProviderRequestAuthSource(provider: string, source: ProviderRequestAuthSource): void {
		const stale = this.staleProviderRequestAuthSources.get(provider);
		if (!stale) {
			return;
		}
		const next = stale.filter(
			(token) => token.source !== source.source || token.identityFingerprint !== source.identityFingerprint,
		);
		if (next.length === 0) {
			this.staleProviderRequestAuthSources.delete(provider);
		} else {
			this.staleProviderRequestAuthSources.set(provider, next);
		}
	}

	private getProviderRequestAuthSourceToken(
		provider: string,
		source: ProviderRequestAuthSource,
	): AuthSourceToken | undefined {
		const valueFingerprint = source.valueFingerprint ?? source.resolveValueFingerprint?.();
		if (!valueFingerprint) {
			return undefined;
		}
		return {
			provider,
			source: source.source,
			identityFingerprint: source.identityFingerprint,
			valueFingerprint,
		};
	}

	private setLastProviderAuthSourceToken(provider: string, token: AuthSourceToken | undefined): void {
		if (token) {
			this.lastProviderAuthSourceTokens.set(provider, token);
		} else {
			this.lastProviderAuthSourceTokens.delete(provider);
		}
	}

	private hasConfiguredProviderRequestAuth(provider: string): boolean {
		const source = this.getProviderRequestAuthSource(provider);
		return source !== undefined && !this.isProviderRequestAuthStaleForStatus(provider, source);
	}

	markProviderAuthStale(provider: string): boolean {
		if (this.authStorage.markAuthStale(provider)) {
			return true;
		}

		const token = this.getCurrentProviderAuthSourceToken(provider);
		return token ? this.markProviderAuthSourceStale(token) : false;
	}

	getCurrentProviderAuthSourceToken(provider: string): AuthSourceToken | undefined {
		const lastRequestToken = this.lastProviderAuthSourceTokens.get(provider);
		if (lastRequestToken) {
			return lastRequestToken;
		}

		const authStorageToken = this.authStorage.getCurrentAuthSourceToken(provider);
		if (authStorageToken) {
			return authStorageToken;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			return undefined;
		}
		const resolvedApiKey = resolveConfigValueUncached(providerApiKey);
		const source = this.getProviderRequestAuthSource(provider, { resolvedApiKey });
		const valueFingerprint = source?.valueFingerprint ?? source?.resolveValueFingerprint?.();
		if (!source || !valueFingerprint || this.isProviderRequestAuthStale(provider, source)) {
			return undefined;
		}

		return {
			provider,
			source: source.source,
			identityFingerprint: source.identityFingerprint,
			valueFingerprint,
		};
	}

	markProviderAuthSourceStale(token: AuthSourceToken): boolean {
		let marked = false;
		const providerRequestSource = this.getProviderRequestAuthSource(token.provider);
		if (
			providerRequestSource?.source === token.source &&
			providerRequestSource.identityFingerprint === token.identityFingerprint
		) {
			const stale = this.staleProviderRequestAuthSources.get(token.provider) ?? [];
			if (
				!stale.some(
					(existing) =>
						existing.source === token.source &&
						existing.identityFingerprint === token.identityFingerprint &&
						existing.valueFingerprint === token.valueFingerprint,
				)
			) {
				stale.push(token);
			}
			this.staleProviderRequestAuthSources.set(token.provider, stale);
			marked = true;
		}

		if (token.source !== "models_json_key" && token.source !== "models_json_command") {
			marked = this.authStorage.markAuthSourceStale(token) || marked;
		}

		return marked;
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * Get API key and request headers for a model.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const authStorageAuth = await this.authStorage.getApiKeyWithSourceToken(model.provider, {
				includeFallback: false,
			});
			let apiKey = authStorageAuth.apiKey;
			let authSourceToken = authStorageAuth.sourceToken;
			if (apiKey === undefined && providerConfig?.apiKey) {
				const resolvedApiKey = resolveConfigValueOrThrow(
					providerConfig.apiKey,
					`API key for provider "${model.provider}"`,
				);
				const providerRequestAuthSource = this.getProviderRequestAuthSource(model.provider, { resolvedApiKey });
				if (
					providerRequestAuthSource &&
					!this.isProviderRequestAuthStale(model.provider, providerRequestAuthSource)
				) {
					this.clearStaleProviderRequestAuthSource(model.provider, providerRequestAuthSource);
					apiKey = resolvedApiKey;
					authSourceToken = this.getProviderRequestAuthSourceToken(model.provider, providerRequestAuthSource);
				}
			}
			this.setLastProviderAuthSourceToken(model.provider, apiKey === undefined ? undefined : authSourceToken);

			const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
			const authStorageHeaders = this.authStorage.getProviderHeaders(model.provider);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
			);

			let headers =
				model.headers || authStorageHeaders || providerHeaders || modelHeaders
					? { ...model.headers, ...authStorageHeaders, ...providerHeaders, ...modelHeaders }
					: undefined;

			if (providerConfig?.authHeader) {
				if (!apiKey) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Return auth status for a provider, including request auth configured in models.json.
	 * This intentionally does not execute command-backed config values.
	 */
	getProviderAuthStatus(provider: string): AuthStatus {
		const authStatus = this.authStorage.getAuthStatus(provider);
		if (authStatus.source && authStatus.source !== "stale") {
			return authStatus;
		}

		const source = this.getProviderRequestAuthSource(provider);
		if (!source) {
			return authStatus;
		}

		if (this.isProviderRequestAuthStaleForStatus(provider, source)) {
			return { configured: false, source: "stale", label: "expired" };
		}

		return {
			configured: true,
			source: source.source,
			...(source.label ? { label: source.label } : {}),
		};
	}

	/**
	 * Get display name for a provider.
	 */
	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);
		const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

		return (
			registeredProvider?.name ??
			registeredProvider?.oauth?.name ??
			oauthProvider?.name ??
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			provider
		);
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const authStorageAuth = await this.authStorage.getApiKeyWithSourceToken(provider, { includeFallback: false });
		if (authStorageAuth.apiKey !== undefined) {
			this.setLastProviderAuthSourceToken(provider, authStorageAuth.sourceToken);
			return authStorageAuth.apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			this.setLastProviderAuthSourceToken(provider, undefined);
			return undefined;
		}

		const resolvedApiKey = resolveConfigValueUncached(providerApiKey);
		if (resolvedApiKey === undefined) {
			this.setLastProviderAuthSourceToken(provider, undefined);
			return undefined;
		}
		const source = this.getProviderRequestAuthSource(provider, { resolvedApiKey });
		if (!source || this.isProviderRequestAuthStale(provider, source)) {
			this.setLastProviderAuthSourceToken(provider, undefined);
			return undefined;
		}
		this.clearStaleProviderRequestAuthSource(provider, source);
		this.setLastProviderAuthSourceToken(provider, this.getProviderRequestAuthSourceToken(provider, source));

		return resolvedApiKey;
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.upsertRegisteredProvider(providerName, config);
	}

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes the provider from the registry and reloads models from disk so that
	 * built-in models overridden by this provider are restored to their original state.
	 * Also resets dynamic OAuth and API stream registrations before reapplying
	 * remaining dynamic providers.
	 * Has no effect if the provider was never registered.
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	/**
	 * Upsert a provider config into registeredProviders.
	 * If the provider is already registered, defined values in the incoming config
	 * override existing ones; undefined values are preserved from the stored config.
	 * If the provider is not registered, the incoming config is stored as-is.
	 */
	private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, config);
			return;
		}
		for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[k] !== undefined) {
				(existing as Record<string, unknown>)[k] = config[k];
			}
		}
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		// Register OAuth provider if provided
		if (config.oauth) {
			// Ensure the OAuth provider ID matches the provider name
			const oauthProvider: OAuthProviderInterface = {
				...config.oauth,
				id: providerName,
			};
			registerOAuthProvider(oauthProvider);
		}

		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}

		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			// Full replacement: remove existing models for this provider
			this.models = this.models.filter((m) => m.provider !== providerName);

			// Parse and add new models
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				this.models.push({
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? config.baseUrl!,
					reasoning: modelDef.reasoning,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>);
			}

			// Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
			if (config.oauth?.modifyModels) {
				const cred = this.authStorage.get(providerName);
				if (cred?.type === "oauth") {
					this.models = config.oauth.modifyModels(this.models, cred);
				}
			}
		} else if (config.baseUrl || config.headers) {
			// Override-only: update baseUrl for existing models. Request headers are resolved per request.
			this.models = this.models.map((m) => {
				if (m.provider !== providerName) return m;
				return {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
				};
			});
		}
	}
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	/** OAuth provider for /login support */
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
}
