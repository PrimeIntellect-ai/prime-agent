/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GenerateContentResponse,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost } from "../models.js";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

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

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
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
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
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
			// Extract text and image content
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

/**
 * Strip meta-declarations from a schema obj
 */
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

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
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

/**
 * Map Gemini FinishReason to our StopReason.
 */
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

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

// =============================================================================
// Stream processing
// =============================================================================

// Counter for generating unique tool call IDs. Shared across both adapters so a
// Gemini and a Vertex stream running concurrently cannot mint the same id.
let toolCallCounter = 0;

/**
 * Consume a Gemini/Vertex `generateContentStream` and push normalized events.
 *
 * Both Google adapters speak the same wire format via `@google/genai`, so the
 * block state machine, tool-call handling, finish-reason mapping and usage
 * accounting live here; the adapters own only client construction, auth, and the
 * API-specific `thinkingConfig` shape.
 *
 * Mutates `output` in place and pushes to `stream`. It does not push `done`,
 * `error`, or `start`, and does not inspect the abort signal -- the adapter owns
 * the stream lifecycle so it can attach its own request metadata to failures.
 */
export async function processGoogleStream(
	googleStream: AsyncIterable<GenerateContentResponse>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<GoogleApiType>,
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;

	const endCurrentBlock = () => {
		if (!currentBlock) return;
		if (currentBlock.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: currentBlock.text,
				partial: output,
			});
		} else {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: currentBlock.thinking,
				partial: output,
			});
		}
	};

	for await (const chunk of googleStream) {
		// @google/genai documents GenerateContentResponse.responseId as an output-only
		// field used to identify each response. Keep the first non-empty one.
		output.responseId ||= chunk.responseId;
		const candidate = chunk.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					const isThinking = isThinkingPart(part);
					if (
						!currentBlock ||
						(isThinking && currentBlock.type !== "thinking") ||
						(!isThinking && currentBlock.type !== "text")
					) {
						endCurrentBlock();
						if (isThinking) {
							currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
							output.content.push(currentBlock);
							stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
						} else {
							currentBlock = { type: "text", text: "" };
							output.content.push(currentBlock);
							stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
						}
					}
					if (currentBlock.type === "thinking") {
						currentBlock.thinking += part.text;
						currentBlock.thinkingSignature = retainThoughtSignature(
							currentBlock.thinkingSignature,
							part.thoughtSignature,
						);
						stream.push({
							type: "thinking_delta",
							contentIndex: blockIndex(),
							delta: part.text,
							partial: output,
						});
					} else {
						currentBlock.text += part.text;
						currentBlock.textSignature = retainThoughtSignature(
							currentBlock.textSignature,
							part.thoughtSignature,
						);
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: part.text,
							partial: output,
						});
					}
				}

				if (part.functionCall) {
					if (currentBlock) {
						endCurrentBlock();
						currentBlock = null;
					}

					// Generate unique ID if not provided or if it's a duplicate
					const providedId = part.functionCall.id;
					const needsNewId =
						!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
					const toolCallId = needsNewId
						? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
						: providedId;

					const toolCall: ToolCall = {
						type: "toolCall",
						id: toolCallId,
						name: part.functionCall.name || "",
						arguments: (part.functionCall.args as Record<string, any>) ?? {},
						...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
					};

					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
					stream.push({
						type: "toolcall_delta",
						contentIndex: blockIndex(),
						delta: JSON.stringify(toolCall.arguments),
						partial: output,
					});
					stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
				}
			}
		}

		if (candidate?.finishReason) {
			output.stopReason = mapStopReason(candidate.finishReason);
			if (output.content.some((b) => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			}
			if (output.stopReason === "error") {
				output.stopReasonRaw = candidate.finishReason;
			}
		}

		if (chunk.usageMetadata) {
			output.usage = {
				input: (chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
				output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
				cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
				cacheWrite: 0,
				totalTokens: chunk.usageMetadata.totalTokenCount || 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};
			calculateCost(model, output.usage);
		}
	}

	endCurrentBlock();
}

// =============================================================================
// Request configuration
// =============================================================================

export interface GoogleThinkingOptions {
	enabled: boolean;
	budgetTokens?: number; // -1 for dynamic, 0 to disable
	level?: GoogleThinkingLevel;
}

export interface BuildGoogleParamsOptions {
	temperature?: number;
	maxTokens?: number;
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
	signal?: AbortSignal;
}

export interface GoogleThinkingConfigBuilder {
	/**
	 * Build the `thinkingConfig` for a model whose thinking is enabled. Gemini and
	 * Vertex take the same levels but different value types: the Gemini API accepts
	 * the raw string, Vertex requires the SDK's `ThinkingLevel` enum member.
	 */
	enabled: (thinking: GoogleThinkingOptions) => ThinkingConfig;
	/** Build the `thinkingConfig` that suppresses thinking for this model. */
	disabled: (modelId: string) => ThinkingConfig;
}

/**
 * Build `GenerateContentParameters` for either Google API.
 *
 * Everything except `thinkingConfig` is identical between the two; the caller
 * supplies that via `thinkingConfigBuilder`.
 */
export function buildGoogleParams(
	model: Model<GoogleApiType>,
	context: Context,
	options: BuildGoogleParamsOptions,
	thinkingConfigBuilder: GoogleThinkingConfigBuilder,
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		config.thinkingConfig = thinkingConfigBuilder.enabled(options.thinking);
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = thinkingConfigBuilder.disabled(model.id);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

// =============================================================================
// Model family detection
// =============================================================================

export function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

export function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

export function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}
