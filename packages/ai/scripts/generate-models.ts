#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getAnthropicCacheCosts } from "../src/cache-pricing.js";
import { getOpenRouterReasoningCapabilities } from "../src/openrouter-reasoning.js";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/providers/cloudflare.js";
import {
	Api,
	type AnthropicMessagesCompat,
	KnownProvider,
	Model,
	type OpenAICompletionsCompat,
} from "../src/types.js";
import { MODELS as EXISTING_MODELS } from "../src/models.generated.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

interface AiGatewayModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const KIMI_STATIC_HEADERS = {
	"User-Agent": "KimiCLI/1.5",
} as const;

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "max",
	max: null,
} as const;

const KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
} as const;

const DEEPSEEK_V4_COMPAT: OpenAICompletionsCompat = {
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

const ZAI_THINKING_COMPAT: OpenAICompletionsCompat = {
	supportsReasoningEffort: false,
	thinkingFormat: "zai",
};

const PRIME_INFERENCE_BASE_URL = "https://api.pinference.ai/api/v1";
const PRIME_INFERENCE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};
interface PrimeInferenceCatalogEntry {
	id: string;
	input: number;
	output: number;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

interface PrimeInferenceModelMetadata {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	name?: string;
}

// The full Prime Inference catalog is registered (minus raw/duplicate variants).
// Prime's /models endpoint publishes pricing only, so context/output limits and
// modalities are read from OpenRouter's public catalog, used here purely as a
// published spec sheet for the same upstream models — requests always go to
// Prime's own baseUrl. Entries below override those specs where the Prime route
// enforces a different limit (verified against the live API) or fill gaps for
// models OpenRouter does not list or leaves incomplete.
const PRIME_INFERENCE_MODEL_METADATA: Record<string, PrimeInferenceModelMetadata> = {
	// These routes accept 200k, checked against the live API 2026-07-08. The
	// other Claude routes take the full window their spec lists.
	"anthropic/claude-sonnet-4": { contextWindow: 200000 },
	"anthropic/claude-sonnet-4.5": { contextWindow: 200000 },
	// Windows confirmed against the live API 2026-07-08 where they are SMALLER
	// than the published spec — over-declaring breaks context tracking.
	"meta-llama/llama-3.2-1b-instruct": { contextWindow: 60000 },
	"meta-llama/llama-3.2-3b-instruct": { contextWindow: 80000 },
	"minimax/minimax-m3": { contextWindow: 524288 },
	"moonshotai/kimi-k2-0905": { contextWindow: 98304 },
	"nvidia/nemotron-3-super-120b-a12b": { contextWindow: 262144, maxTokens: 4096 },
	// Enforced window is LARGER than OpenRouter's listing.
	"qwen/qwen3-30b-a3b-instruct-2507": { contextWindow: 262144 },
	// OpenRouter has no max_completion_tokens for the rest of these.
	"moonshotai/kimi-k2.5": { maxTokens: 65535 },
	"minimax/minimax-m2.7": { maxTokens: 131072 },
	// models.dev (moonshotai + openrouter) both list output = context for k2.6.
	"moonshotai/kimi-k2.6": { maxTokens: 262144 },
	"moonshotai/kimi-k3": { maxTokens: 1048576 },
	"openai/gpt-4.1": { maxTokens: 32768 },
	"openai/gpt-5-nano": { maxTokens: 128000 },
	"openai/gpt-oss-20b": { maxTokens: 131072 },
	"qwen/qwen3.5-397b-a17b": { maxTokens: 65536 },
	"x-ai/grok-4.20": { maxTokens: 30000 },
	"x-ai/grok-4.20-multi-agent": { maxTokens: 30000 },
	"xiaomi/mimo-v2.5": { maxTokens: 131072 },
	"z-ai/glm-5": { maxTokens: 131072 },
};

// Flagship models pinned above the long tail in the model picker, so the full
// catalog doesn't flood /model. Everything else stays selectable via search.
const PRIME_INFERENCE_FEATURED_MODELS = new Set([
	"anthropic/claude-fable-5",
	"anthropic/claude-haiku-4.5",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-sonnet-4.5",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-5",
	"deepseek/deepseek-v3.2",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-pro",
	"minimax/minimax-m3",
	"moonshotai/kimi-k2.7-code",
	"moonshotai/kimi-k3",
	"nvidia/nemotron-3-nano-30b-a3b",
	"nvidia/nemotron-3-super-120b-a12b",
	"openai/gpt-5.3-codex",
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.4-pro",
	"openai/gpt-5.5",
	"qwen/qwen3-30b-a3b-instruct-2507",
	"qwen/qwen3-coder-next",
	"qwen/qwen3-max",
	"qwen/qwen3-vl-235b-a22b-thinking",
	"qwen/qwen3.8-max",
	"x-ai/grok-4.20",
	"x-ai/grok-4.20-multi-agent",
	"z-ai/glm-5",
	"z-ai/glm-5.1",
	"z-ai/glm-5.2",
]);

// Prime ids whose OpenRouter listing uses a different id. Empty today — Prime
// currently publishes ids that match OpenRouter's, but HF-style ids show up
// whenever a new route is added, so the mapping stays.
const PRIME_INFERENCE_OPENROUTER_ALIASES: Record<string, string> = {};

// Conservative fallbacks for catalog models with no OpenRouter match and no
// override above: an under-declared window degrades gracefully, an
// over-declared one breaks context tracking.
const PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW = 128000;
const PRIME_INFERENCE_DEFAULT_MAX_TOKENS = 8192;

// Raw checkpoints and duplicate routes that would clutter the picker: BF16
// exports, fine-tune outputs, zai-org/ and HF-cased twins of canonical ids.
function isPrimeInferenceRawVariant(modelId: string): boolean {
	const id = modelId.toLowerCase();
	if (id.endsWith("-bf16") || id.includes(":")) {
		return true;
	}
	const vendor = modelId.split("/")[0] ?? "";
	return vendor === "zai-org" || vendor !== vendor.toLowerCase();
}

function isPrimeInferencePrivateModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return id.startsWith("internal/") || id.startsWith("dev/");
}

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6")
	);
}

function isGoogleThinkingApi(model: Model<any>): boolean {
	return model.api === "google-generative-ai" || model.api === "google-vertex";
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.id.includes("gpt-5.6")) {
		mergeThinkingLevelMap(model, { minimal: null, max: "max" });
	}
	// Per-family effort support per the Anthropic effort docs. Opus 4.6 / Sonnet 4.6
	// have no xhigh; Fable 5 / Mythos 5 / Mythos Preview think every turn (off: null).
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("sonnet-5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5") || model.id.includes("mythos-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("mythos-preview")) {
		mergeThinkingLevelMap(model, { off: null, max: "max" });
	}
	if (model.api === "openai-completions" && model.id.includes("deepseek-v4")) {
		mergeThinkingLevelMap(model, DEEPSEEK_V4_THINKING_LEVEL_MAP);
	}
	const kimiK3Id = model.id.toLowerCase();
	if (!model.thinkingLevelMap && (/^k3(-|$)/.test(kimiK3Id) || /(^|\/)kimi-k3(-|$)/.test(kimiK3Id))) {
		mergeThinkingLevelMap(model, KIMI_K3_THINKING_LEVEL_MAP);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" });
	}
	if (isGoogleThinkingApi(model) && isGemini3FlashModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" });
	}
	if (
		model.provider === "openai-codex" &&
		supportsOpenAiXhigh(model.id) &&
		!model.id.includes("gpt-5.6")
	) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (model.provider === "openai-codex" && model.id === "gpt-5.1-codex-mini") {
		mergeThinkingLevelMap(model, { minimal: "medium", low: "medium", medium: "medium", high: "high" });
	}
}

function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	return EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
		? { supportsEagerToolInputStreaming: false }
		: undefined;
}

function getBedrockBaseUrl(modelId: string): string {
	if (modelId.startsWith("eu.")) return "https://bedrock-runtime.eu-central-1.amazonaws.com";
	if (modelId.startsWith("au.")) return "https://bedrock-runtime.ap-southeast-2.amazonaws.com";
	if (modelId.startsWith("jp.")) return "https://bedrock-runtime.ap-northeast-1.amazonaws.com";
	return "https://bedrock-runtime.us-east-1.amazonaws.com";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getOptionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readPrimeCliConfig(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(join(homedir(), ".prime", "config.json"), "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function getPrimeInferenceConfigValue(
	envName: "PRIME_API_KEY" | "PRIME_TEAM_ID",
	config: Record<string, unknown>,
	configKeys: readonly string[],
): string | undefined {
	const fromEnv = process.env[envName]?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	for (const key of configKeys) {
		const value = config[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}

	return undefined;
}

function getPrimeInferenceHeaders(apiKey: string | undefined, teamId: string | undefined): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	if (teamId) {
		headers["X-Prime-Team-ID"] = teamId;
	}

	return Object.keys(headers).length > 0 ? headers : undefined;
}

function getPrimeInferenceCacheCosts(modelId: string, inputCost: number): { cacheRead: number; cacheWrite: number } {
	return modelId.toLowerCase().startsWith("anthropic/")
		? getAnthropicCacheCosts(inputCost, "5m")
		: { cacheRead: 0, cacheWrite: 0 };
}

function getExistingPrimeInferenceModels(): Model<"openai-completions">[] {
	const models = EXISTING_MODELS["prime-inference"] as unknown as Record<string, Model<"openai-completions">>;
	return Object.values(models)
		.filter((model) => !isPrimeInferenceRawVariant(model.id) && !isPrimeInferencePrivateModel(model.id))
		.map((model) => ({
			...model,
			input: [...model.input],
			cost: {
				...model.cost,
				...getPrimeInferenceCacheCosts(model.id, model.cost.input),
			},
			...(model.compat ? { compat: { ...model.compat } } : {}),
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			...(model.headers ? { headers: { ...model.headers } } : {}),
		}));
}

function mergePrimeInferenceModels(
	snapshotModels: Model<"openai-completions">[],
	catalogModels: Model<"openai-completions">[],
): Model<"openai-completions">[] {
	const models = new Map<string, Model<"openai-completions">>();
	for (const model of snapshotModels) {
		models.set(model.id.toLowerCase(), model);
	}
	for (const model of catalogModels) {
		models.set(model.id.toLowerCase(), model);
	}
	return Array.from(models.values());
}

function refreshPrimeInferenceAliasLimits(
	snapshotModels: Model<"openai-completions">[],
	catalogModels: Model<"openai-completions">[],
): Model<"openai-completions">[] {
	const liveModels = new Map(catalogModels.map((model) => [model.id.toLowerCase(), model]));
	return snapshotModels.map((model) => {
		const canonicalId = PRIME_INFERENCE_OPENROUTER_ALIASES[model.id.toLowerCase()];
		const canonical = canonicalId ? liveModels.get(canonicalId) : undefined;
		if (!canonical) {
			return model;
		}
		return {
			...model,
			contextWindow: canonical.contextWindow,
			maxTokens: canonical.maxTokens,
		};
	});
}

function includesCatalogCapability(value: unknown, capabilities: readonly string[]): boolean {
	if (!Array.isArray(value)) {
		return false;
	}

	return value.some((item) => {
		if (typeof item !== "string") {
			return false;
		}
		const normalized = item.toLowerCase();
		return capabilities.some((capability) => normalized.includes(capability));
	});
}

function getPrimeInferenceDisplayName(modelId: string): string {
	const rawName = modelId.split("/").at(-1) ?? modelId;
	return rawName
		.split(/[-_]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			if (part === part.toUpperCase() || /\d/.test(part)) return part.toUpperCase();
			if (part.length <= 3) return part.toUpperCase();
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

function getPrimeInferenceCatalogReasoning(item: Record<string, unknown>): boolean | undefined {
	const metadata = isRecord(item.metadata) ? item.metadata : {};
	const direct =
		getOptionalBoolean(item.reasoning) ??
		getOptionalBoolean(item.supports_reasoning) ??
		getOptionalBoolean(item.supportsReasoning) ??
		getOptionalBoolean(metadata.reasoning) ??
		getOptionalBoolean(metadata.supports_reasoning) ??
		getOptionalBoolean(metadata.supportsReasoning);
	if (direct !== undefined) {
		return direct;
	}

	return includesCatalogCapability(item.supported_parameters, ["reasoning", "thinking"]) ||
		includesCatalogCapability(item.capabilities, ["reasoning", "thinking"]) ||
		includesCatalogCapability(item.tags, ["reasoning", "thinking"]) ||
		includesCatalogCapability(metadata.supported_parameters, ["reasoning", "thinking"]) ||
		includesCatalogCapability(metadata.capabilities, ["reasoning", "thinking"]) ||
		includesCatalogCapability(metadata.tags, ["reasoning", "thinking"])
		? true
		: undefined;
}

function isPrimeInferenceReasoningModel(modelId: string, catalogReasoning?: boolean): boolean {
	if (catalogReasoning !== undefined) {
		return catalogReasoning;
	}

	const id = modelId.toLowerCase();
	return (
		id.includes("thinking") ||
		id.includes("deepseek-v4") ||
		id.startsWith("minimax/minimax-m") ||
		id.startsWith("moonshotai/kimi") ||
		id.startsWith("x-ai/grok-4") ||
		id.startsWith("z-ai/glm-") ||
		(id.startsWith("openai/gpt-5") && !id.includes("-chat")) ||
		/^anthropic\/claude-(?:fable-5|opus-4|sonnet-(?:4|5))/.test(id)
	);
}

function getPrimeInferenceCompat(modelId: string): OpenAICompletionsCompat {
	const id = modelId.toLowerCase();
	if (id.includes("deepseek-v4")) {
		return {
			...PRIME_INFERENCE_COMPAT,
			...DEEPSEEK_V4_COMPAT,
		};
	}
	if (id.startsWith("z-ai/glm-")) {
		return {
			...PRIME_INFERENCE_COMPAT,
			...ZAI_THINKING_COMPAT,
		};
	}

	return PRIME_INFERENCE_COMPAT;
}

function parsePrimeInferenceCatalog(data: unknown): PrimeInferenceCatalogEntry[] {
	if (!isRecord(data) || !Array.isArray(data.data)) {
		return [];
	}

	return data.data.flatMap((item): PrimeInferenceCatalogEntry[] => {
		if (!isRecord(item) || typeof item.id !== "string") {
			return [];
		}

		const pricing = isRecord(item.pricing) ? item.pricing : {};
		const input = getOptionalNumber(pricing.input_usd_per_mtok);
		const output = getOptionalNumber(pricing.output_usd_per_mtok);
		if (input === undefined || output === undefined) {
			return [];
		}

		const limit = isRecord(item.limit) ? item.limit : {};
		return [
			{
				id: item.id,
				input,
				output,
				contextWindow: getOptionalNumber(item.context_window ?? item.contextWindow ?? limit.context),
				maxTokens: getOptionalNumber(item.max_tokens ?? item.maxTokens ?? limit.output),
				reasoning: getPrimeInferenceCatalogReasoning(item),
			},
		];
	});
}

interface PrimeInferenceOpenRouterMetadata {
	contextWindow?: number;
	maxTokens?: number;
	vision: boolean;
	reasoning: boolean;
	thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
	supportsReasoningEffort?: boolean;
}

function buildPrimeInferenceOpenRouterIndex(catalog: unknown[]): Map<string, PrimeInferenceOpenRouterMetadata> {
	const index = new Map<string, PrimeInferenceOpenRouterMetadata>();
	for (const item of catalog) {
		if (!isRecord(item) || typeof item.id !== "string") {
			continue;
		}
		const topProvider = isRecord(item.top_provider) ? item.top_provider : {};
		const architecture = isRecord(item.architecture) ? item.architecture : {};
		const modalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
		const supportedParameters = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
		const reasoningCapabilities = getOpenRouterReasoningCapabilities(item);
		index.set(item.id.toLowerCase(), {
			contextWindow: getOptionalNumber(item.context_length) ?? getOptionalNumber(topProvider.context_length),
			maxTokens: getOptionalNumber(topProvider.max_completion_tokens),
			vision: modalities.includes("image"),
			// Same signal the OpenRouter provider path uses; the top-level
			// `reasoning` object over-reports (e.g. qwen3-max carries one despite
			// not accepting reasoning params).
			reasoning: supportedParameters.includes("reasoning"),
			...(reasoningCapabilities?.thinkingLevelMap
				? { thinkingLevelMap: reasoningCapabilities.thinkingLevelMap }
				: {}),
			...(reasoningCapabilities?.supportsReasoningEffort === false
				? { supportsReasoningEffort: false }
				: {}),
		});
	}
	return index;
}

function getPrimeInferenceOpenRouterMetadata(
	index: Map<string, PrimeInferenceOpenRouterMetadata>,
	modelId: string,
): PrimeInferenceOpenRouterMetadata | undefined {
	const id = modelId.toLowerCase();
	return index.get(PRIME_INFERENCE_OPENROUTER_ALIASES[id] ?? id);
}

async function fetchPrimeInferenceModels(): Promise<Model<"openai-completions">[]> {
	const primeConfig = readPrimeCliConfig();
	const apiKey = getPrimeInferenceConfigValue("PRIME_API_KEY", primeConfig, ["api_key", "apiKey"]);
	const teamId = getPrimeInferenceConfigValue("PRIME_TEAM_ID", primeConfig, ["team_id", "teamId", "teamID"]);
	let catalog: PrimeInferenceCatalogEntry[] = [];

	try {
		console.log("Fetching models from Prime Inference API...");
		const response = await fetch(`${PRIME_INFERENCE_BASE_URL}/models`, {
			headers: getPrimeInferenceHeaders(apiKey, teamId),
		});
		catalog = parsePrimeInferenceCatalog(await response.json());
	} catch (error) {
		console.error("Failed to fetch Prime Inference models:", error);
	}

	let openRouterIndex = new Map<string, PrimeInferenceOpenRouterMetadata>();
	try {
		openRouterIndex = buildPrimeInferenceOpenRouterIndex(await fetchOpenRouterCatalog());
	} catch (error) {
		console.error("Failed to fetch OpenRouter catalog for Prime Inference metadata:", error);
	}
	if (openRouterIndex.size === 0) {
		// Without OpenRouter metadata every model would regress to the defaults;
		// keep the previous snapshot instead.
		console.error("OpenRouter catalog unavailable; keeping snapshot Prime Inference models");
		return getExistingPrimeInferenceModels();
	}

	const catalogModels = catalog
		.filter((entry) => !isPrimeInferenceRawVariant(entry.id) && !isPrimeInferencePrivateModel(entry.id))
		.map((entry) =>
			createPrimeInferenceModel(
				entry,
				PRIME_INFERENCE_MODEL_METADATA[entry.id.toLowerCase()],
				getPrimeInferenceOpenRouterMetadata(openRouterIndex, entry.id),
			),
		);
	let snapshotModels = getExistingPrimeInferenceModels();
	if (catalog.length > 0) {
		const liveIds = new Set(catalogModels.map((model) => model.id.toLowerCase()));
		snapshotModels = snapshotModels.filter((model) => liveIds.has(model.id.toLowerCase()));
	}
	snapshotModels = refreshPrimeInferenceAliasLimits(snapshotModels, catalogModels);
	const models = mergePrimeInferenceModels(snapshotModels, catalogModels);
	console.log(`Loaded ${models.length} Prime Inference models (${catalogModels.length} from the live catalog)`);
	return models;
}

function createPrimeInferenceModel(
	entry: PrimeInferenceCatalogEntry,
	override: PrimeInferenceModelMetadata | undefined,
	openRouter: PrimeInferenceOpenRouterMetadata | undefined,
): Model<"openai-completions"> {
	const vision = override?.vision ?? openRouter?.vision ?? false;
	const cacheCosts = getPrimeInferenceCacheCosts(entry.id, entry.input);
	const contextWindow =
		entry.contextWindow ??
		override?.contextWindow ??
		openRouter?.contextWindow ??
		PRIME_INFERENCE_DEFAULT_CONTEXT_WINDOW;
	// Sources are independent, so an OpenRouter output cap can exceed a
	// gateway-measured window override; clamp to keep the pair coherent.
	const maxTokens = Math.min(
		entry.maxTokens ?? override?.maxTokens ?? openRouter?.maxTokens ?? PRIME_INFERENCE_DEFAULT_MAX_TOKENS,
		contextWindow,
	);
	const compat = getPrimeInferenceCompat(entry.id);
	return {
		id: entry.id,
		...(PRIME_INFERENCE_FEATURED_MODELS.has(entry.id.toLowerCase()) ? { featured: true } : {}),
		name: override?.name ?? getPrimeInferenceDisplayName(entry.id),
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: PRIME_INFERENCE_BASE_URL,
		reasoning: isPrimeInferenceReasoningModel(entry.id, entry.reasoning ?? openRouter?.reasoning),
		...(openRouter?.thinkingLevelMap ? { thinkingLevelMap: openRouter.thinkingLevelMap } : {}),
		input: vision ? ["text", "image"] : ["text"],
		cost: {
			input: entry.input,
			output: entry.output,
			...cacheCosts,
		},
		contextWindow,
		maxTokens,
		compat: {
			...compat,
			...(openRouter?.supportsReasoningEffort === false
				? {
						supportsReasoningEffort: false,
						...(!compat.thinkingFormat ? { thinkingFormat: "openrouter" as const } : {}),
					}
				: {}),
		},
	};
}

let openRouterCatalogPromise: Promise<any[]> | undefined;

function fetchOpenRouterCatalog(): Promise<any[]> {
	openRouterCatalogPromise ??= (async () => {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		const data = await response.json();
		return Array.isArray(data?.data) ? data.data : [];
	})();
	return openRouterCatalogPromise;
}

async function fetchOpenRouterModels(): Promise<Model<any>[]> {
	try {
		const models: Model<any>[] = [];

		for (const model of await fetchOpenRouterCatalog()) {
			// Only include models that support tools
			if (!model.supported_parameters?.includes("tools")) continue;
			// :batch routes are asynchronous batch variants, not streaming models
			if (model.id.endsWith(":batch")) continue;

			// Parse provider from model ID
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// Convert pricing from $/token to $/million tokens. OpenRouter uses
			// negative values as a placeholder for unknown pricing (e.g. auto-beta).
			const inputCost = Math.max(0, parseFloat(model.pricing?.prompt || "0")) * 1_000_000;
			const outputCost = Math.max(0, parseFloat(model.pricing?.completion || "0")) * 1_000_000;
			const cacheReadCost = Math.max(0, parseFloat(model.pricing?.input_cache_read || "0")) * 1_000_000;
			const cacheWriteCost = Math.max(0, parseFloat(model.pricing?.input_cache_write || "0")) * 1_000_000;
			const reasoningCapabilities = getOpenRouterReasoningCapabilities(model);

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				...(reasoningCapabilities?.thinkingLevelMap
					? { thinkingLevelMap: reasoningCapabilities.thinkingLevelMap }
					: {}),
				...(reasoningCapabilities?.supportsReasoningEffort === false
					? { compat: { supportsReasoningEffort: false } }
					: {}),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_length || 4096,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		return [];
	}
}

async function fetchAiGatewayModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		const data = await response.json();
		const models: Model<any>[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = toNumber(model.pricing?.input) * 1_000_000;
			const outputCost = toNumber(model.pricing?.output) * 1_000_000;
			const cacheReadCost = toNumber(model.pricing?.input_cache_read) * 1_000_000;
			const cacheWriteCost = toNumber(model.pricing?.input_cache_write) * 1_000_000;

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				// DeepSeek's *-thinking routes always think; the gateway omits the tag.
				reasoning: tags.includes("reasoning") || model.id.includes("-thinking"),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable models from Vercel AI Gateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		return [];
	}
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();

		const models: Model<any>[] = [];

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				let id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Google models. Live API models (bidirectional streaming sessions), Deep
		// Research models (Interactions API), and Computer Use models (require the
		// computer_use tool) are not usable through the GenerateContent API as plain
		// chat models, so they are excluded.
		const googleUnsupportedApiModelPattern = /(^|[-_.])(live|deep-research|computer-use)($|[-_.])/i;
		if (data.google?.models) {
			for (const [modelId, model] of Object.entries(data.google.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (googleUnsupportedApiModelPattern.test(modelId)) continue;
				// Image-generation variants return inlineData parts the provider drops.
				if (m.modalities?.output?.includes("image")) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
			}
		}

		// Process Cloudflare AI Gateway models
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId;
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// workers-ai/* through the gateway forwards x-session-affinity to
				// the underlying Workers AI runtime for prefix-cache routing.
				const compat = upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process zAi models
		if (data["zai-coding-plan"]?.models) {
			for (const [modelId, model] of Object.entries(data["zai-coding-plan"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				const supportsImage = m.modalities?.input?.includes("image");

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "zai",
					baseUrl: "https://api.z.ai/api/coding/paas/v4",
					reasoning: m.reasoning === true,
					input: supportsImage ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
						thinkingFormat: ZAI_THINKING_COMPAT.thinkingFormat,
						...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Fireworks models
		if (data["fireworks-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["fireworks-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "fireworks",
					// Fireworks Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.fireworks.ai/inference",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/zen" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
				// accept Anthropic SDK auth (MiniMax M2.7) or are served through
				// the OpenAI-compatible /v1/chat/completions path (Qwen routes).
				// Switch them to openai-completions so requests use Bearer auth
				// and the standard /v1/chat/completions endpoint.
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7" || (npm === "@ai-sdk/anthropic" && modelId.startsWith("qwen"))) {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process GitHub Copilot models
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel & { status?: string };
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Copilot proxies Claude via the Anthropic Messages API
				const isCopilotClaude = modelId.startsWith("claude-");
				// gpt-5 models require responses API, others use completions
				const needsResponsesApi = modelId.startsWith("gpt-5") || modelId.startsWith("oswe");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// compat only applies to openai-completions
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
			}
		}

		// Process MiniMax models
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
				}
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-for-coding"]?.models) {
			const kimiModels = data["kimi-for-coding"].models as Record<string, ModelsDevModel>;
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6"]);

			for (const [modelId, model] of Object.entries(kimiModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev may expose versioned aliases (e.g. k2p5/k2p6).
				// Normalize aliases to the canonical model id and drop duplicates when canonical exists.
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					headers: { ...KIMI_STATIC_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			if (!data[key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[key].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: moonshotCompat,
				});
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiVariants = [
			{ provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-cn", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-ams", baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic" },
			{ provider: "xiaomi-token-plan-sgp", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" },
		] as const;

		if (data.xiaomi?.models) {
			for (const { provider, baseUrl } of xiaomiVariants) {
				for (const [modelId, model] of Object.entries(data.xiaomi.models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
				}
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

async function generateModels() {
	// Fetch models from both sources
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras
	// OpenRouter: xAI and other providers (excluding Anthropic, Google, OpenAI)
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const openRouterModels = await fetchOpenRouterModels();
	const aiGatewayModels = await fetchAiGatewayModels();

	// Combine models (models.dev has priority)
	const allModels = [...modelsDevModels, ...openRouterModels, ...aiGatewayModels].filter(
		(model) =>
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	// Fix incorrect cache pricing for Claude Opus 4.5 from models.dev
	// models.dev has 3x the correct pricing (1.5/18.75 instead of 0.5/6.25)
	const opus45 = allModels.find(m => m.provider === "anthropic" && m.id === "claude-opus-4-5");
	if (opus45) {
		opus45.cost.cacheRead = 0.5;
		opus45.cost.cacheWrite = 6.25;
	}

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "amazon-bedrock" && candidate.id.includes("anthropic.claude-opus-4-6-v1")) {
			candidate.cost.cacheRead = 0.5;
			candidate.cost.cacheWrite = 6.25;
		}
		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go" ||
				candidate.provider === "github-copilot") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && (candidate.id === "gpt-5.4" || candidate.id === "gpt-5.5")) {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k3") {
			candidate.maxTokens = 1048576;
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}

	}


	// Add missing EU Opus 4.6 profile
	if (!allModels.some((m) => m.provider === "amazon-bedrock" && m.id === "eu.anthropic.claude-opus-4-6-v1")) {
		allModels.push({
			id: "eu.anthropic.claude-opus-4-6-v1",
			name: "Claude Opus 4.6 (EU)",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: getBedrockBaseUrl("eu.anthropic.claude-opus-4-6-v1"),
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 200000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-6")) {
		allModels.push({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.7
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-7")) {
		allModels.push({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Sonnet 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")) {
		allModels.push({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
		});
	}

	// Add missing Gemini 3.1 Flash Lite Preview until models.dev includes it.
	if (!allModels.some((m) => m.provider === "google" && m.id === "gemini-3.1-flash-lite-preview")) {
		allModels.push({
			id: "gemini-3.1-flash-lite-preview",
			name: "Gemini 3.1 Flash Lite Preview",
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			provider: "google",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 65536,
		});
	}

	// Add missing gpt models
	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5-chat-latest")) {
		allModels.push({
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex")) {
		allModels.push({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 5,
				cacheRead: 0.125,
				cacheWrite: 1.25,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex-max")) {
		allModels.push({
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.3-codex-spark")) {
		allModels.push({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	// Add missing GitHub Copilot GPT-5.3 models until models.dev includes them.
	const copilotBaseModel = allModels.find(
		(m) => m.provider === "github-copilot" && m.id === "gpt-5.2-codex",
	);
	if (copilotBaseModel) {
		if (!allModels.some((m) => m.provider === "github-copilot" && m.id === "gpt-5.3-codex")) {
			allModels.push({
				...copilotBaseModel,
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex",
			});
		}
	}

	if (!allModels.some((m) => m.provider === "openai" && m.id === "gpt-5.4")) {
		allModels.push({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2.5,
				output: 15,
				cacheRead: 0.25,
				cacheWrite: 0,
			},
			contextWindow: 272000,
			maxTokens: 128000,
		});
	}

	const deepseekV4Models: Model<"openai-completions">[] = [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.0028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_V4_COMPAT,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.435,
				output: 0.87,
				cacheRead: 0.003625,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_V4_COMPAT,
		},
	];
	allModels.push(...deepseekV4Models);

	for (const candidate of allModels) {
		if (candidate.api === "openai-completions" && candidate.id.includes("deepseek-v4")) {
			candidate.compat = {
				...candidate.compat,
				...(candidate.provider === "openrouter"
					? {
							requiresReasoningContentOnAssistantMessages:
								DEEPSEEK_V4_COMPAT.requiresReasoningContentOnAssistantMessages,
							thinkingFormat: DEEPSEEK_V4_COMPAT.thinkingFormat,
						}
					: DEEPSEEK_V4_COMPAT),
			};
			mergeThinkingLevelMap(candidate, DEEPSEEK_V4_THINKING_LEVEL_MAP);
		}
	}

	const minimaxDirectSupportedIds = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);

	for (const candidate of allModels) {
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			minimaxDirectSupportedIds.has(candidate.id)
		) {
			candidate.contextWindow = 204800;
			candidate.maxTokens = 131072;
		}
	}

	for (let i = allModels.length - 1; i >= 0; i--) {
		const candidate = allModels[i];
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			!minimaxDirectSupportedIds.has(candidate.id)
		) {
			allModels.splice(i, 1);
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Context window is based on observed server limits (400s above ~272k), not marketing numbers.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.1",
			name: "GPT-5.1",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2",
			name: "GPT-5.2",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2-codex",
			name: "GPT-5.2 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4-mini",
			name: "GPT-5.4 Mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	// Add missing Grok models
	if (!allModels.some(m => m.provider === "xai" && m.id === "grok-code-fast-1")) {
		allModels.push({
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-completions",
			baseUrl: "https://api.x.ai/v1",
			provider: "xai",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.2,
				output: 1.5,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 32768,
			maxTokens: 8192,
		});
	}

	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some(m => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
	const vertexModels: Model<"google-vertex">[] = [
		{
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 64000,
		},
		{
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.1-pro-preview-customtools",
			name: "Gemini 3.1 Pro Preview Custom Tools (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash Preview (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.0-flash",
			name: "Gemini 2.0 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		},
		{
			id: "gemini-2.0-flash-lite",
			name: "Gemini 2.0 Flash Lite (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash-lite-preview-09-2025",
			name: "Gemini 2.5 Flash Lite Preview 09-25 (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash-lite",
			name: "Gemini 2.5 Flash Lite (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-1.5-pro",
			name: "Gemini 1.5 Pro (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 1.25, output: 5, cacheRead: 0.3125, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
		{
			id: "gemini-1.5-flash",
			name: "Gemini 1.5 Flash (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
		{
			id: "gemini-1.5-flash-8b",
			name: "Gemini 1.5 Flash-8B (Vertex)",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: VERTEX_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.0375, output: 0.15, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		},
	];
	allModels.push(...vertexModels);

	const primeInferenceModels = await fetchPrimeInferenceModels();
	allModels.push(...primeInferenceModels);

	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "",
		}));
	allModels.push(...azureOpenAiModels);

	for (const model of allModels) {
		applyThinkingLevelMetadata(model);
	}

	// Group by provider and deduplicate by model ID
	const providers: Record<string, Record<string, Model<any>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over OpenRouter)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Generate TypeScript file
	let output = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import type { Model } from "./types.js";

export const MODELS = {
`;

	// Generate provider sections (sorted for deterministic output)
	const sortedProviderIds = Object.keys(providers).sort();
	for (const providerId of sortedProviderIds) {
		const models = providers[providerId];
		output += `\t${JSON.stringify(providerId)}: {\n`;

		const sortedModelIds = Object.keys(models).sort();
		for (const modelId of sortedModelIds) {
			const model = models[modelId];
			output += `\t\t"${model.id}": {\n`;
			output += `\t\t\tid: "${model.id}",\n`;
			output += `\t\t\tname: "${model.name}",\n`;
			output += `\t\t\tapi: "${model.api}",\n`;
			output += `\t\t\tprovider: "${model.provider}",\n`;
			if (model.baseUrl !== undefined) {
				output += `\t\t\tbaseUrl: "${model.baseUrl}",\n`;
			}
			if (model.headers) {
				output += `\t\t\theaders: ${JSON.stringify(model.headers)},\n`;
			}
			if (model.compat) {
				output += `			compat: ${JSON.stringify(model.compat)},
`;
			}
			output += `\t\t\treasoning: ${model.reasoning},\n`;
			if (model.thinkingLevelMap) {
				output += `\t\t\tthinkingLevelMap: ${JSON.stringify(model.thinkingLevelMap)},\n`;
			}
			output += `\t\t\tinput: [${model.input.map(i => `"${i}"`).join(", ")}],\n`;
			output += `\t\t\tcost: {\n`;
			output += `\t\t\t\tinput: ${model.cost.input},\n`;
			output += `\t\t\t\toutput: ${model.cost.output},\n`;
			output += `\t\t\t\tcacheRead: ${model.cost.cacheRead},\n`;
			output += `\t\t\t\tcacheWrite: ${model.cost.cacheWrite},\n`;
			output += `\t\t\t},\n`;
			output += `\t\t\tcontextWindow: ${model.contextWindow},\n`;
			output += `\t\t\tmaxTokens: ${model.maxTokens},\n`;
			if (model.featured) {
				output += `\t\t\tfeatured: true,\n`;
			}
			output += `\t\t} satisfies Model<"${model.api}">,\n`;
		}

		output += `\t},\n`;
	}

	output += `} as const;
`;

	// Write file
	writeFileSync(join(packageRoot, "src/models.generated.ts"), output);
	console.log("Generated src/models.generated.ts");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch(console.error);
