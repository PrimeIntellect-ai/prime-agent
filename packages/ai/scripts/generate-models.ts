#!/usr/bin/env tsx

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "url";
import { COPILOT_CLIENT_HEADERS } from "../src/copilot-client-version.js";
import { getOpenRouterReasoningCapabilities } from "../src/openrouter-reasoning.js";
import { parseModelCatalog } from "../src/model-catalog.js";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/providers/cloudflare.js";
import type {
	AnthropicMessagesCompat,
	Api,
	KnownProvider,
	Model,
	OpenAICompletionsCompat,
} from "../src/types.js";


interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: {
		type?: string;
		values?: string[];
	}[];
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

interface ModelsDevProviderData {
	models?: Record<string, ModelsDevModel>;
}

type ModelsDevApiData = Record<string, ModelsDevProviderData>;

const COPILOT_STATIC_HEADERS = COPILOT_CLIENT_HEADERS;

const KIMI_STATIC_HEADERS = {
	"User-Agent": "KimiCLI/1.5",
} as const;

const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const MODELS_DEV_FETCH_HEADERS = {
	"User-Agent": "prime-agent-model-catalog-exporter/1.0",
} as const;
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

const MODELS_DEV_PROVIDER_IDS = [
	"amazon-bedrock",
	"anthropic",
	"azure-openai-responses",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"openai",
	"opencode",
	"opencode-go",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
] as const;

interface CatalogCollection {
	providers: Record<string, Model<Api>[]>;
	skippedProviders: Record<string, string>;
	skippedModels: CatalogSkippedModel[];
}

interface CatalogSkippedModel {
	provider: string;
	id: string;
	reason: string;
}

interface SyncSummary {
	provider: string;
	updated: number;
	added: number;
	delisted: number;
	notInUpstream: number;
	skipped: number;
	manual?: boolean;
	skippedReason?: string;
}

type CatalogModelRecord = Record<string, unknown> & { id: string };

interface WhitelistPolicy {
	source: string;
	ids: string[];
	globs: string[];
}

interface CatalogPolicy {
	whitelists: Map<string, WhitelistPolicy>;
	manuals: Map<string, CatalogModelRecord[]>;
}

interface CatalogEnvelope {
	schemaVersion: 1;
	models: CatalogModelRecord[];
}

interface AdmissionManifest {
	schemaVersion: 1;
	admitted: Record<string, string[]>;
}

interface GlobAdmission {
	id: string;
	glob: string;
}

interface MergeSummary extends Omit<SyncSummary, "provider" | "manual" | "skippedReason"> {
	globAdmitted: GlobAdmission[];
	delistedIds: string[];
	notInUpstreamIds: string[];
}

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
	// gpt-6 reasoning is mandatory with no minimal effort; xhigh/max are supported (OpenRouter capability data).
	if (model.id.includes("gpt-6")) {
		mergeThinkingLevelMap(model, { minimal: null, xhigh: "xhigh", max: "max" });
	}
	if (
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses") &&
		model.id.startsWith("gpt-6")
	) {
		mergeThinkingLevelMap(model, { off: null });
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

let openRouterCatalogPromise: Promise<any[]> | undefined;

function fetchOpenRouterCatalog(): Promise<any[]> {
	openRouterCatalogPromise ??= (async () => {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		if (!response.ok) {
			throw new Error(`OpenRouter catalog request failed with HTTP ${response.status}`);
		}
		const data = (await response.json()) as { data?: unknown[] };
		return Array.isArray(data.data) ? data.data : [];
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
			// Time-windowed tariff overrides (utc_start/utc_end) make the top-level
			// price clock-dependent (e.g. Tencent Hy3 peak/off-peak); commit the peak
			// rate so cost accounting never undercounts and regens stay hour-independent.
			const timeWindowedTariffs = (Array.isArray(model.pricing?.overrides) ? model.pricing.overrides : []).filter(
				(override: any) => typeof override?.utc_start === "number",
			);
			const peakPrice = (field: string): number =>
				Math.max(
					0,
					parseFloat(model.pricing?.[field] || "0"),
					...timeWindowedTariffs.map((override: any) => parseFloat(override?.[field] || "0")),
				) * 1_000_000;
			const inputCost = peakPrice("prompt");
			const outputCost = peakPrice("completion");
			const cacheReadCost = peakPrice("input_cache_read");
			const cacheWriteCost = peakPrice("input_cache_write");
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
		throw new Error(`Failed to fetch OpenRouter models: ${formatError(error)}`);
	}
}

function getModelsDevInputModalities(model: ModelsDevModel): ("text" | "image")[] {
	if (!Array.isArray(model.modalities?.input) || model.modalities.input.length === 0) {
		return [];
	}
	return model.modalities.input.includes("image") ? ["text", "image"] : ["text"];
}

function getModelsDevRequiredNumber(value: number | undefined): number {
	return value as number;
}

function getModelsDevCacheCost(value: number | undefined): number {
	return value ?? 0;
}

function getModelsDevCost(model: ModelsDevModel): Model<any>["cost"] {
	return {
		input: getModelsDevRequiredNumber(model.cost?.input),
		output: getModelsDevRequiredNumber(model.cost?.output),
		cacheRead: getModelsDevCacheCost(model.cost?.cache_read),
		cacheWrite: getModelsDevCacheCost(model.cost?.cache_write),
	};
}

function getModelsDevContextWindow(model: ModelsDevModel): number {
	return getModelsDevRequiredNumber(model.limit?.context);
}

function getModelsDevMaxTokens(model: ModelsDevModel): number {
	return getModelsDevRequiredNumber(model.limit?.output);
}

export function getModelsDevThinkingLevelMap(model: ModelsDevModel): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	const effortOption = model.reasoning_options?.find(
		(option) => option.type === "effort" && Array.isArray(option.values),
	);
	if (!effortOption) {
		return undefined;
	}

	const supportedValues = new Set(effortOption.values);
	const map: NonNullable<Model<any>["thinkingLevelMap"]> = {};
	const setLevel = (level: keyof NonNullable<Model<any>["thinkingLevelMap"]>, upstreamValue: string): void => {
		map[level] = supportedValues.has(upstreamValue) ? upstreamValue : null;
	};

	map.off = supportedValues.has("none") ? "none" : supportedValues.has("off") ? "off" : null;
	setLevel("minimal", "minimal");
	setLevel("low", "low");
	setLevel("medium", "medium");
	setLevel("high", "high");
	setLevel("xhigh", "xhigh");
	setLevel("max", "max");
	return map;
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json", { headers: MODELS_DEV_FETCH_HEADERS });
		if (!response.ok) {
			throw new Error(`models.dev catalog request failed with HTTP ${response.status}`);
		}
		const data = (await response.json()) as ModelsDevApiData;

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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
				});
			}
		}

		// Process Google Vertex Gemini models. models.dev also lists Vertex
		// Anthropic routes; those use a different runtime than our google-vertex
		// provider, so keep this provider on the Gemini surface.
		if (data["google-vertex"]?.models) {
			for (const [modelId, model] of Object.entries(data["google-vertex"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.provider?.npm === "@ai-sdk/google-vertex/anthropic") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-vertex",
					provider: "google-vertex",
					baseUrl: "https://{location}-aiplatform.googleapis.com",
					reasoning: m.reasoning === true,
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
				});
			}
		}

		// Process Azure OpenAI models
		if (data.azure?.models) {
			for (const [modelId, model] of Object.entries(data.azure.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "azure-openai-responses",
					provider: "azure-openai-responses",
					baseUrl: "",
					reasoning: m.reasoning === true,
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
				});
			}
		}

		// Process DeepSeek models
		if (data.deepseek?.models) {
			for (const [modelId, model] of Object.entries(data.deepseek.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "deepseek",
					baseUrl: "https://api.deepseek.com",
					reasoning: m.reasoning === true,
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
				});
			}
		}

		// Process zAi models
		if (data["zai-coding-plan"]?.models) {
			for (const [modelId, model] of Object.entries(data["zai-coding-plan"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "zai",
					baseUrl: "https://api.z.ai/api/coding/paas/v4",
					reasoning: m.reasoning === true,
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					compat: {
						supportsDeveloperRole: false,
						thinkingFormat: ZAI_THINKING_COMPAT.thinkingFormat,
						...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
					},
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
			const variantModels = data[variant.key]?.models;
			if (!variantModels) continue;

			for (const [modelId, model] of Object.entries(variantModels)) {
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					...(compat ? { compat } : {}),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
				// gpt-5/gpt-6 models require responses API, others use completions
				const needsResponsesApi =
					modelId.startsWith("gpt-5") || modelId.startsWith("gpt-6") || modelId.startsWith("oswe");

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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
						...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
						input: getModelsDevInputModalities(m),
						cost: getModelsDevCost(m),
						contextWindow: getModelsDevContextWindow(m),
						maxTokens: getModelsDevMaxTokens(m),
					});
				}
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-code-plan-cn"]?.models) {
			const kimiModels = data["kimi-code-plan-cn"].models as Record<string, ModelsDevModel>;
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
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
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
					compat: moonshotCompat,
				});
			}
		}

		// Process Vercel AI Gateway models. Vercel's models.dev slug is "vercel".
		// Some gateway entries omit tool_call even though the gateway catalog has
		// historically advertised tool-use; refresh any structurally complete entry
		// so existing catalog ids can stay billing-authoritative to models.dev.
		if (data.vercel?.models) {
			for (const [modelId, model] of Object.entries(data.vercel.models)) {
				const m = model as ModelsDevModel;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "vercel-ai-gateway",
					baseUrl: AI_GATEWAY_BASE_URL,
					reasoning: m.reasoning === true || modelId.includes("-thinking"),
					...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
					input: getModelsDevInputModalities(m),
					cost: getModelsDevCost(m),
					contextWindow: getModelsDevContextWindow(m),
					maxTokens: getModelsDevMaxTokens(m),
				});
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiVariants = [
			{ key: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/anthropic" },
			{
				key: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
			},
			{
				key: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
			},
			{
				key: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
			},
		] as const;

		for (const { key, provider, baseUrl } of xiaomiVariants) {
			if (!data[key]?.models) continue;
			for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						baseUrl,
						reasoning: m.reasoning === true,
						...(getModelsDevThinkingLevelMap(m) ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) } : {}),
						input: getModelsDevInputModalities(m),
						cost: getModelsDevCost(m),
						contextWindow: getModelsDevContextWindow(m),
						maxTokens: getModelsDevMaxTokens(m),
					});
			}
		}

		console.log(`Loaded ${models.length} models from models.dev`);
		return models;
	} catch (error) {
		throw new Error(`Failed to load models.dev data: ${formatError(error)}`);
	}
}

async function collectCatalogModelsWithStatus(): Promise<CatalogCollection> {
	const skippedProviders: Record<string, string> = {};
	const skippedModels: CatalogSkippedModel[] = [];
	const collectedModels: Model<Api>[] = [];

	try {
		collectedModels.push(...(await loadModelsDevData()));
	} catch (error) {
		const reason = formatError(error);
		for (const provider of MODELS_DEV_PROVIDER_IDS) {
			skippedProviders[provider] = reason;
		}
	}

	try {
		collectedModels.push(...(await fetchOpenRouterModels()));
	} catch (error) {
		skippedProviders.openrouter = formatError(error);
	}

	const allModels = collectedModels.filter(
		(model) =>
			model.provider !== "prime-inference" &&
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
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
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

	// Pin the shipped Kimi For Coding rows. models.dev split the retired
	// kimi-for-coding section into kimi-code-plan-global (api.kimi.ai) and
	// kimi-code-plan-cn, both re-registered as OpenAI-compatible deployments
	// that do not match this provider's verified Anthropic-messages surface on
	// api.kimi.com/coding. Keep the existing rows until the provider is
	// migrated to one of the new deployments with verified request shapes.
	const kimiCodingModels: Model<"anthropic-messages">[] = [
		{
			id: "k3",
			name: "Kimi K3",
			api: "anthropic-messages",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			headers: { ...KIMI_STATIC_HEADERS },
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 131072,
		},
		{
			id: "k3-256k",
			name: "Kimi K3-256K",
			api: "anthropic-messages",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			headers: { ...KIMI_STATIC_HEADERS },
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 131072,
		},
		{
			id: "kimi-for-coding",
			name: "Kimi K2.7 Code",
			api: "anthropic-messages",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			headers: { ...KIMI_STATIC_HEADERS },
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
		},
		{
			id: "kimi-for-coding-highspeed",
			name: "Kimi For Coding HighSpeed",
			api: "anthropic-messages",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			headers: { ...KIMI_STATIC_HEADERS },
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
		},
	];
	for (const kimiModel of kimiCodingModels) {
		if (!allModels.some((m) => m.provider === "kimi-coding" && m.id === kimiModel.id)) {
			allModels.push(kimiModel);
		}
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


	for (const model of allModels) {
		applyThinkingLevelMetadata(model);
	}

	const providers: Record<string, Model<Api>[]> = {};
	const seenProviderModelIds = new Set<string>();
	for (const model of allModels) {
		if (skippedProviders[model.provider]) {
			continue;
		}
		const invalidReason = getInvalidModelReason(model);
		if (invalidReason) {
			skippedModels.push({ provider: model.provider, id: model.id || "<missing>", reason: invalidReason });
			continue;
		}
		const dedupeKey = `${model.provider}\u0000${model.id}`;
		if (seenProviderModelIds.has(dedupeKey)) {
			continue;
		}
		seenProviderModelIds.add(dedupeKey);
		providers[model.provider] ??= [];
		providers[model.provider].push(model);
	}

	return { providers, skippedProviders, skippedModels };
}


function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getInvalidModelReason(model: Model<Api>): string | undefined {
	if (!model.id) return "missing id";
	if (!model.name) return "missing name";
	if (!model.api) return "missing api";
	if (!model.provider) return "missing provider";
	if (typeof model.baseUrl !== "string") return "missing baseUrl";
	if (typeof model.reasoning !== "boolean") return "missing reasoning";
	if (!Array.isArray(model.input) || model.input.length === 0) return "missing input modalities";
	if (!model.input.every((input) => input === "text" || input === "image")) return "invalid input modality";
	if (!isFiniteNumber(model.cost?.input)) return "missing input cost";
	if (!isFiniteNumber(model.cost?.output)) return "missing output cost";
	if (!isFiniteNumber(model.cost?.cacheRead)) return "missing cacheRead cost";
	if (!isFiniteNumber(model.cost?.cacheWrite)) return "missing cacheWrite cost";
	if (!isFiniteNumber(model.contextWindow) || model.contextWindow <= 0) return "missing contextWindow";
	if (!isFiniteNumber(model.maxTokens) || model.maxTokens <= 0) return "missing maxTokens";
	return undefined;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeCanonicalJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function isCatalogModelRecord(value: unknown): value is CatalogModelRecord {
	return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

const REFRESH_METADATA_KEYS = [
	"name",
	"cost",
	"contextWindow",
	"maxTokens",
	"input",
	"reasoning",
	"thinkingLevelMap",
	"compat",
] as const;

const OPTIONAL_REFRESH_METADATA_KEYS = new Set<string>(["thinkingLevelMap", "compat"]);

const LIVE_UPSTREAM_PROVIDER_SOURCES: Record<string, string> = {
	"amazon-bedrock": "amazon-bedrock",
	anthropic: "anthropic",
	"azure-openai-responses": "azure",
	cerebras: "cerebras",
	"cloudflare-ai-gateway": "cloudflare-ai-gateway",
	"cloudflare-workers-ai": "cloudflare-workers-ai",
	deepseek: "deepseek",
	fireworks: "fireworks-ai",
	"github-copilot": "github-copilot",
	google: "google",
	"google-vertex": "google-vertex",
	groq: "groq",
	huggingface: "huggingface",
	"kimi-coding": "kimi-code-plan-cn",
	minimax: "minimax",
	"minimax-cn": "minimax-cn",
	mistral: "mistral",
	moonshotai: "moonshotai",
	"moonshotai-cn": "moonshotai-cn",
	openai: "openai",
	opencode: "opencode",
	"opencode-go": "opencode-go",
	openrouter: "openrouter-api",
	"vercel-ai-gateway": "vercel",
	xai: "xai",
	xiaomi: "xiaomi",
	"xiaomi-token-plan-ams": "xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn": "xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp": "xiaomi-token-plan-sgp",
	zai: "zai-coding-plan",
};

/**
 * Providers backed by a live upstream catalog endpoint. Only these are synced.
 * Admission is controlled by models/whitelist/<provider>.yml in the catalog repo.
 */
const LIVE_UPSTREAM_PROVIDERS = new Set<string>(Object.keys(LIVE_UPSTREAM_PROVIDER_SOURCES));

/**
 * The client's catalog schema rejects request headers on catalog entries
 * (createModelCatalog strips them; parseModelCatalog drops entries that carry
 * them). Header values live in the compiled transport templates instead —
 * catalog data must never change where credentials are sent.
 */
function stripCatalogHeaders<T extends Model<Api>>(model: T): T {
	if (!("headers" in model) || model.headers === undefined) return model;
	const clone = { ...model };
	delete clone.headers;
	return clone;
}

export function mergeProviderModelsForCatalog(
	existingModels: CatalogModelRecord[],
	collectedModels: Model<Api>[],
	admission: { ids: string[]; globs: string[] },
): { models: CatalogModelRecord[]; summary: MergeSummary } {
	const sanitizedModels = collectedModels.map(stripCatalogHeaders);
	const collectedById = new Map(sanitizedModels.map((model) => [model.id, model]));
	const existingById = new Map(existingModels.map((model) => [model.id, model]));
	const admittedIds: string[] = [];
	const admittedSet = new Set<string>();

	for (const id of admission.ids) {
		admittedIds.push(id);
		admittedSet.add(id);
	}

	const globAdmitted: GlobAdmission[] = [];
	for (const collected of sanitizedModels) {
		if (admittedSet.has(collected.id)) {
			continue;
		}
		const glob = admission.globs.find((candidate) => matchesGlob(collected.id, candidate));
		if (!glob) {
			continue;
		}
		admittedIds.push(collected.id);
		admittedSet.add(collected.id);
		globAdmitted.push({ id: collected.id, glob });
	}

	let skipped = 0;
	for (const existing of existingModels) {
		if (admittedSet.has(existing.id)) {
			continue;
		}
		if (!admission.globs.some((glob) => matchesGlob(existing.id, glob))) {
			continue;
		}
		admittedIds.push(existing.id);
		admittedSet.add(existing.id);
		skipped += 1;
	}

	const nextModels: CatalogModelRecord[] = [];
	const notInUpstreamIds: string[] = [];
	let updated = 0;
	let added = 0;

	for (const id of admittedIds) {
		const collected = collectedById.get(id);
		const existing = existingById.get(id);
		if (collected) {
			if (existing) {
				updated += 1;
				nextModels.push(mergeExistingCatalogModel(existing, collected));
			} else {
				added += 1;
				nextModels.push(cloneJson(collected) as CatalogModelRecord);
			}
			continue;
		}
		if (!existing) {
			throw new Error(`Whitelisted model id ${id} is missing from both upstream and the committed provider file`);
		}
		notInUpstreamIds.push(id);
		nextModels.push(sanitizeExistingCatalogModel(existing));
	}

	const delistedIds = existingModels.filter((model) => !admittedSet.has(model.id)).map((model) => model.id);

	return {
		models: nextModels,
		summary: {
			updated,
			added,
			delisted: delistedIds.length,
			notInUpstream: notInUpstreamIds.length,
			skipped,
			globAdmitted,
			delistedIds,
			notInUpstreamIds,
		},
	};
}

const CATALOG_MODEL_KEYS = new Set([
	"id", "name", "api", "provider", "baseUrl", "reasoning", "thinkingLevelMap",
	"input", "cost", "contextWindow", "maxTokens", "featured", "compat",
]);

function sanitizeExistingCatalogModel(existing: CatalogModelRecord): CatalogModelRecord {
	return Object.fromEntries(Object.entries(existing).filter(([key]) => CATALOG_MODEL_KEYS.has(key))) as CatalogModelRecord;
}

function mergeExistingCatalogModel(existing: CatalogModelRecord, collected: Model<Api>): CatalogModelRecord {
	const collectedRecord = collected as unknown as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	const seenKeys = new Set<string>();
	for (const [key, value] of Object.entries(sanitizeExistingCatalogModel(existing))) {
		seenKeys.add(key);
		if (!REFRESH_METADATA_KEYS.includes(key as (typeof REFRESH_METADATA_KEYS)[number])) {
			next[key] = value;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(collectedRecord, key)) {
			next[key] = cloneJson(collectedRecord[key]);
		} else if (!OPTIONAL_REFRESH_METADATA_KEYS.has(key)) {
			next[key] = value;
		}
	}

	for (const key of REFRESH_METADATA_KEYS) {
		if (!seenKeys.has(key) && Object.prototype.hasOwnProperty.call(collectedRecord, key)) {
			next[key] = cloneJson(collectedRecord[key]);
		}
	}

	return next as CatalogModelRecord;
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function matchesGlob(value: string, glob: string): boolean {
	let source = "^";
	for (const char of glob) {
		if (char === "*") {
			source += ".*";
		} else if (char === "?") {
			source += ".";
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`).test(value);
}

function readYamlFile(path: string): unknown {
	try {
		return parseYaml(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: invalid YAML: ${formatError(error)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${path} must be a string array`);
	}
	const seen = new Set<string>();
	for (const item of value) {
		if (seen.has(item)) {
			throw new Error(`${path} contains duplicate value ${item}`);
		}
		seen.add(item);
	}
	return value;
}

function readYamlPolicyDir(dir: string, label: string): string[] {
	if (!existsSync(dir)) {
		throw new Error(`Catalog ${label} directory does not exist: ${dir}`);
	}
	return readdirSync(dir, { withFileTypes: true })
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((item) => {
			if (!item.isFile() || !item.name.endsWith(".yml")) {
				throw new Error(`${dir} must contain only .yml files; found ${item.name}`);
			}
			return item.name;
		});
}

export function readCatalogPolicy(catalogDir: string): CatalogPolicy {
	const whitelistDir = join(catalogDir, "models", "whitelist");
	const manualDir = join(catalogDir, "models", "manual");
	const whitelists = new Map<string, WhitelistPolicy>();
	const manuals = new Map<string, CatalogModelRecord[]>();

	for (const file of readYamlPolicyDir(whitelistDir, "whitelist")) {
		const provider = file.slice(0, -".yml".length);
		if (!LIVE_UPSTREAM_PROVIDERS.has(provider)) {
			throw new Error(
				`models/whitelist/${file} has no upstream exporter mapping; use models/manual/${file} for curated providers`,
			);
		}
		const path = join(whitelistDir, file);
		const parsed = readYamlFile(path);
		if (!isRecord(parsed)) {
			throw new Error(`${path} must contain an object`);
		}
		const extras = Object.keys(parsed).filter((key) => !["source", "ids", "globs"].includes(key));
		if (extras.length > 0) {
			throw new Error(`${path} has unsupported keys: ${extras.join(", ")}`);
		}
		if (typeof parsed.source !== "string") {
			throw new Error(`${path}.source must be a string`);
		}
		const expectedSource = LIVE_UPSTREAM_PROVIDER_SOURCES[provider];
		if (parsed.source !== expectedSource) {
			throw new Error(`${path}.source is ${parsed.source}, expected ${expectedSource}`);
		}
		whitelists.set(provider, {
			source: parsed.source,
			ids: assertStringArray(parsed.ids, `${path}.ids`),
			globs: assertStringArray(parsed.globs, `${path}.globs`),
		});
	}

	for (const file of readYamlPolicyDir(manualDir, "manual")) {
		const provider = file.slice(0, -".yml".length);
		if (whitelists.has(provider)) {
			throw new Error(`${provider} is present in both models/whitelist and models/manual`);
		}
		const path = join(manualDir, file);
		const parsed = readYamlFile(path);
		if (!isRecord(parsed)) {
			throw new Error(`${path} must contain an object`);
		}
		const extras = Object.keys(parsed).filter((key) => key !== "models");
		if (extras.length > 0) {
			throw new Error(`${path} has unsupported keys: ${extras.join(", ")}`);
		}
		if (!Array.isArray(parsed.models) || !parsed.models.every(isCatalogModelRecord)) {
			throw new Error(`${path}.models must be an array of model objects with string ids`);
		}
		const manualModels = parsed.models.map((model) => stripCatalogHeaders(model as unknown as Model<Api>) as unknown as CatalogModelRecord);
		for (const model of manualModels) {
			if (model.provider !== provider) {
				throw new Error(`${path}: model ${model.id} provider must match ${provider}`);
			}
			const invalidReason = getInvalidModelReason(model as unknown as Model<Api>);
			if (invalidReason) {
				throw new Error(`${path}: model ${model.id} is invalid: ${invalidReason}`);
			}
		}
		manuals.set(provider, manualModels);
	}

	return { whitelists, manuals };
}

function readCommittedCatalog(path: string): CatalogEnvelope {
	const parsed = readJsonFile(path);
	if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.models)) {
		throw new Error(`${path} must be an object with schemaVersion 1 and a models array`);
	}
	if (!parsed.models.every(isCatalogModelRecord)) {
		throw new Error(`${path}.models must contain model objects with string ids`);
	}
	return { schemaVersion: 1, models: parsed.models };
}

function groupCatalogModelsByProvider(models: CatalogModelRecord[]): Map<string, CatalogModelRecord[]> {
	const providers = new Map<string, CatalogModelRecord[]>();
	for (const model of models) {
		if (typeof model.provider !== "string") {
			throw new Error(`models/catalog.v1.json: model ${model.id} provider must be a string`);
		}
		providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
	}
	return providers;
}

function buildAdmissionManifest(models: CatalogModelRecord[]): AdmissionManifest {
	const admitted: Record<string, string[]> = {};
	for (const model of models) {
		if (typeof model.provider !== "string") {
			throw new Error(`models/catalog.v1.json: model ${model.id} provider must be a string`);
		}
		admitted[model.provider] ??= [];
		admitted[model.provider].push(model.id);
	}
	return { schemaVersion: 1, admitted };
}

function parseArgs(argv: string[]): { catalogOut?: string } {
	let catalogOut: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--catalog-out") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--catalog-out requires a directory");
			}
			catalogOut = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { catalogOut };
}

export async function syncCatalog(catalogDir: string): Promise<number> {
	const policy = readCatalogPolicy(catalogDir);
	const collection = await collectCatalogModelsWithStatus();
	const catalogPath = join(catalogDir, "models", "catalog.v1.json");
	const manifestPath = join(catalogDir, "models", "admission-manifest.v1.json");
	const existingCatalog = readCommittedCatalog(catalogPath);
	const existingByProvider = groupCatalogModelsByProvider(existingCatalog.models);

	for (const provider of existingByProvider.keys()) {
		if (!policy.whitelists.has(provider) && !policy.manuals.has(provider)) {
			throw new Error(
				`${provider} is present in models/catalog.v1.json but not in models/whitelist or models/manual; add an explicit policy file`,
			);
		}
	}

	const summaries: SyncSummary[] = [];
	const nextModels: CatalogModelRecord[] = [];
	for (const provider of [...policy.whitelists.keys(), ...policy.manuals.keys()].sort()) {
		const whitelist = policy.whitelists.get(provider);
		const manual = policy.manuals.get(provider);
		if (whitelist && manual) {
			throw new Error(`${provider} is present in both models/whitelist and models/manual`);
		}

		if (manual) {
			nextModels.push(...manual);
			summaries.push({
				provider,
				updated: manual.length,
				added: 0,
				delisted: 0,
				notInUpstream: 0,
				skipped: 0,
				manual: true,
			});
			continue;
		}

		if (!whitelist) {
			throw new Error(`${provider} is present in models/manual but not readable as a manual policy`);
		}

		const existing = existingByProvider.get(provider) ?? [];
		const skippedReason = collection.skippedProviders[provider];
		if (skippedReason) {
			if (existing.length === 0) {
				throw new Error(`${provider} upstream sync failed and no committed models/catalog.v1.json entries exist to keep`);
			}
			nextModels.push(...existing.map(sanitizeExistingCatalogModel));
			summaries.push({
				provider,
				updated: 0,
				added: 0,
				delisted: 0,
				notInUpstream: 0,
				skipped: 0,
				skippedReason,
			});
			continue;
		}

		const providerSkippedModels = collection.skippedModels.filter((model) => model.provider === provider);
		const merged = mergeProviderModelsForCatalog(existing, collection.providers[provider] ?? [], whitelist);
		merged.summary.skipped = providerSkippedModels.length;
		nextModels.push(...merged.models);
		summaries.push({ provider, ...merged.summary });

		for (const admission of merged.summary.globAdmitted) {
			console.log(`${provider}: glob-admitted ${admission.id} via ${admission.glob}`);
		}
		for (const id of merged.summary.delistedIds) {
			console.error(`${provider}: delisted ${id} (not admitted by whitelist)`);
		}
		for (const id of merged.summary.notInUpstreamIds) {
			console.error(`${provider}: not-in-upstream ${id}; kept committed aggregate entry`);
		}
		for (const skipped of providerSkippedModels) {
			console.error(`${provider}: skipped ${skipped.id}: ${skipped.reason}`);
		}
	}

	const nextCatalog: CatalogEnvelope = { schemaVersion: 1, models: nextModels };
	parseModelCatalog(nextCatalog);
	const manifest = buildAdmissionManifest(nextCatalog.models);
	writeCanonicalJson(catalogPath, nextCatalog);
	writeCanonicalJson(manifestPath, manifest);

	console.log("Catalog sync summary:");
	for (const summary of summaries) {
		if (summary.skippedReason) {
			console.error(`${summary.provider}: skipped provider: ${summary.skippedReason}`);
		} else if (summary.manual) {
			console.log(`${summary.provider}: manual ${summary.updated}, added 0, delisted 0, not-in-upstream 0, skipped 0`);
		} else {
			console.log(
				`${summary.provider}: updated ${summary.updated}, added ${summary.added}, delisted ${summary.delisted}, not-in-upstream ${summary.notInUpstream}, skipped ${summary.skipped}`,
			);
		}
	}
	console.log(`Wrote ${manifestPath}`);

	return Object.keys(collection.skippedProviders).length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (!args.catalogOut) {
			console.error(
				"The compiled full model catalog moved to PrimeIntellect-ai/prime-agent-catalog. Run this exporter with --catalog-out <catalog-repo-dir> to sync that checkout. This command no longer writes packages/ai/src/models.generated.ts.",
			);
			process.exitCode = 1;
			return;
		}
		process.exitCode = await syncCatalog(args.catalogOut);
	} catch (error) {
		console.error(formatError(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main();
}
