import { type GenerateContentParameters, GoogleGenAI, type ThinkingConfig } from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
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
	isGemma4Model,
	processGoogleStream,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
}

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
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
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, apiKey, options?.headers);
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

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning || options.reasoning === "off") {
		return streamGoogle(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const googleModel = model as Model<"google-generative-ai">;

	if (isGemini3ProModel(googleModel.id) || isGemini3FlashModel(googleModel.id) || isGemma4Model(googleModel.id)) {
		return streamGoogle(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, googleModel.id),
			},
		} satisfies GoogleOptions);
	}

	return streamGoogle(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleThinkingBudget(googleModel.id, effort, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	return buildGoogleParams(model, context, options, {
		enabled: (thinking) => {
			const thinkingConfig: ThinkingConfig = { includeThoughts: true };
			if (thinking.level !== undefined) {
				// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
				thinkingConfig.thinkingLevel = thinking.level as any;
			} else if (thinking.budgetTokens !== undefined) {
				thinkingConfig.thinkingBudget = thinking.budgetTokens;
			}
			return thinkingConfig;
		},
		disabled: getDisabledThinkingConfig,
	});
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

function getDisabledThinkingConfig(modelId: string): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	if (isGemini3ProModel(modelId)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(modelId)) {
		return { thinkingLevel: "MINIMAL" as any };
	}
	if (isGemma4Model(modelId)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getThinkingLevel(effort: ClampedThinkingLevel, modelId: string): GoogleThinkingLevel {
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
	if (isGemma4Model(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
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
