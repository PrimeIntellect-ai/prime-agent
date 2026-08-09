import {
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { clampThinkingLevel } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ThinkingLevel as PiThinkingLevel,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
	formatStreamFailureMessage,
	recordStreamFailure,
	streamFailureFromStopReason,
} from "../utils/stream-failure.js";
import type { GoogleThinkingLevel, GoogleThinkingOptions } from "./google-shared.js";
import {
	buildGoogleParams,
	getGoogleThinkingBudget,
	isGemini3FlashModel,
	isGemini3ProModel,
	processGoogleStream,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = resolveApiKey(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers)
				: createClient(model, resolveProject(options), resolveLocation(options), options?.headers);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await client.models.generateContentStream(params);

			stream.push({ type: "start", partial: output });

			await processGoogleStream(googleStream, output, stream, model);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw streamFailureFromStopReason(output.stopReasonRaw);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatStreamFailureMessage(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning || options.reasoning === "off") {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;

	if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getGemini3ThinkingLevel(effort, model.id),
			},
		} satisfies GoogleVertexOptions);
	}

	return streamGoogleVertex(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleThinkingBudget(model.id, effort, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: Record<string, string>,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: Record<string, string>,
): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	return buildGoogleParams(model, context, options, {
		enabled: (thinking) => {
			const thinkingConfig: ThinkingConfig = { includeThoughts: true };
			if (thinking.level !== undefined) {
				thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[thinking.level];
			} else if (thinking.budgetTokens !== undefined) {
				thinkingConfig.thinkingBudget = thinking.budgetTokens;
			}
			return thinkingConfig;
		},
		disabled: getDisabledThinkingConfig,
	});
}

type ClampedThinkingLevel = Exclude<PiThinkingLevel, "xhigh" | "max">;

function getDisabledThinkingConfig(modelId: string): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	if (isGemini3ProModel(modelId)) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	if (isGemini3FlashModel(modelId)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getGemini3ThinkingLevel(effort: ClampedThinkingLevel, modelId: string): GoogleThinkingLevel {
	if (isGemini3ProModel(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}
