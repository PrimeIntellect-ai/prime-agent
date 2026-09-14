/** Shared utilities for Google Generative AI and Vertex providers. */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type Part,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import type {
	Api,
	Context,
	ImageContent,
	Model,
	ThinkingLevel as PiThinkingLevel,
	StopReason,
	TextContent,
	ThinkingBudgets,
	Tool,
} from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/** Thinking level values accepted by Gemini 3 models. */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export type ClampedThinkingLevel = Exclude<PiThinkingLevel, "xhigh" | "max">;

export const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

type GoogleBudgetThinkingLevel = "minimal" | "low" | "medium" | "high";

export function getGoogleThinkingBudget(
	modelId: string,
	effort: GoogleBudgetThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (modelId.includes("2.5-pro")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort];
	}

	if (modelId.includes("2.5-flash-lite")) {
		return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[effort];
	}

	if (modelId.includes("2.5-flash")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort];
	}

	return -1;
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/** Retains a thought signature only for the originating provider/model and when it is valid base64. */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/** Whether this Google API model requires tool-call IDs on function calls and responses. */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

export function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/(?:^|\/|models\/)gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

export function isGemini3ProModel(model: Pick<Model<Api>, "id">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

export function isGemini3FlashModel(model: Pick<Model<Api>, "id">): boolean {
	return /gemini-3(?:\.\d+)?-flash(?!-lite)/.test(model.id.toLowerCase());
}

export function isGemini3FlashLiteModel(model: Pick<Model<Api>, "id">): boolean {
	return /gemini-3(?:\.\d+)?-flash-lite/.test(model.id.toLowerCase());
}

export function isGemma4Model(model: Pick<Model<Api>, "id">): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

export function isGeminiThinkingLevelModel(model: Pick<Model<Api>, "id">): boolean {
	return (getGeminiMajorVersion(model.id) ?? 0) >= 3 || isGemma4Model(model);
}

export function getDisabledThinkingConfig(model: Pick<Model<Api>, "id">): ThinkingConfig {
	if (isGemini3FlashLiteModel(model) || isGemma4Model(model)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}
	if ((getGeminiMajorVersion(model.id) ?? 0) >= 3) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	return { thinkingBudget: 0 };
}

export function getGoogleThinkingLevel(
	effort: ClampedThinkingLevel,
	model: Pick<Model<Api>, "id">,
): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	if (isGemini3FlashModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
				return "MEDIUM";
			case "high":
				return "HIGH";
		}
	}
	if (isGemma4Model(model)) {
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

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/** Converts internal context to Google `Content[]`, preserving replayable signatures only when protocol-valid. */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const parts: Part[] =
				typeof msg.content === "string"
					? [{ text: sanitizeSurrogates(msg.content) }]
					: msg.content.map((item) => {
							if (item.type === "text") {
								return { text: sanitizeSurrogates(item.text) };
							} else {
								return {
									inlineData: {
										mimeType: item.mimeType,
										data: item.data,
									},
								};
							}
						});
			if (parts.length === 0) continue;

			contents.push({
				role: "user",
				parts,
			});
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;

			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/** Converts the generic tool-choice mode to Google's function-calling mode. */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/** Converts Google finish reasons to the shared stop-reason protocol. */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
