import { type TProperties, Type } from "typebox";
import { Value } from "typebox/value";

function createCompatSchemas(strict: boolean) {
	const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: !strict });
	const number = Type.Number(strict ? { minimum: 0 } : {});
	const string = (maxLength: number, minLength = 0) => Type.String(strict ? { minLength, maxLength } : {});
	const stringList = Type.Array(string(256, 1), strict ? { maxItems: 100 } : {});
	const percentileCutoffs = object({
		p50: Type.Optional(number),
		p75: Type.Optional(number),
		p90: Type.Optional(number),
		p99: Type.Optional(number),
	});
	const openRouterRouting = object({
		allow_fallbacks: Type.Optional(Type.Boolean()),
		require_parameters: Type.Optional(Type.Boolean()),
		data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
		zdr: Type.Optional(Type.Boolean()),
		enforce_distillable_text: Type.Optional(Type.Boolean()),
		order: Type.Optional(stringList),
		only: Type.Optional(stringList),
		ignore: Type.Optional(stringList),
		quantizations: Type.Optional(stringList),
		sort: Type.Optional(
			Type.Union([
				string(256),
				object({
					by: Type.Optional(string(256)),
					partition: Type.Optional(Type.Union([string(256), Type.Null()])),
				}),
			]),
		),
		max_price: Type.Optional(
			object({
				prompt: Type.Optional(Type.Union([number, string(128)])),
				completion: Type.Optional(Type.Union([number, string(128)])),
				image: Type.Optional(Type.Union([number, string(128)])),
				audio: Type.Optional(Type.Union([number, string(128)])),
				request: Type.Optional(Type.Union([number, string(128)])),
			}),
		),
		preferred_min_throughput: Type.Optional(Type.Union([number, percentileCutoffs])),
		preferred_max_latency: Type.Optional(Type.Union([number, percentileCutoffs])),
	});
	const vercelGatewayRouting = object({
		only: Type.Optional(stringList),
		order: Type.Optional(stringList),
	});
	const openAICompletions = object({
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
		openRouterRouting: Type.Optional(openRouterRouting),
		vercelGatewayRouting: Type.Optional(vercelGatewayRouting),
		...(strict ? { zaiToolStream: Type.Optional(Type.Boolean()) } : {}),
		supportsStrictMode: Type.Optional(Type.Boolean()),
		cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
		...(strict ? { sendSessionAffinityHeaders: Type.Optional(Type.Boolean()) } : {}),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	});
	const openAIResponses = object({
		sendSessionIdHeader: Type.Optional(Type.Boolean()),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	});
	const anthropicMessages = object({
		supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
		supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	});
	return {
		openAICompletions,
		openAIResponses,
		anthropicMessages,
		provider: Type.Union([openAICompletions, openAIResponses, anthropicMessages]),
	};
}

const strictSchemas = createCompatSchemas(true);
export const ProviderCompatSchema = createCompatSchemas(false).provider;

export function isModelCompat(api: string, value: unknown): boolean {
	if (value === undefined) return true;
	if (api === "openai-completions") return Value.Check(strictSchemas.openAICompletions, value);
	if (api === "openai-responses") return Value.Check(strictSchemas.openAIResponses, value);
	if (api === "anthropic-messages") return Value.Check(strictSchemas.anthropicMessages, value);
	return false;
}
