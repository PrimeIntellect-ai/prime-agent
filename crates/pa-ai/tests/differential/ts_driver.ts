/**
 * Differential driver: run the TS packages/ai openai-completions provider
 * against the SSE replay server and print the final assistant message as
 * JSON for comparison with the Rust port.
 *
 * Run with tsx from a directory containing node_modules (a scratch copy of
 * the TS repo): npx tsx ts_driver.ts <replay-base-url>
 */
import { complete } from "./packages/ai/src/index.js";

const replayBaseUrl = process.argv[2] ?? "http://127.0.0.1:18080/api/v1";

const model = {
	id: "z-ai/glm-5.3-flash",
	name: "GLM 5.3 Flash",
	api: "openai-completions",
	provider: "prime-inference",
	baseUrl: replayBaseUrl,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1310720,
	maxTokens: 131072,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
	},
};

const context = {
	systemPrompt: "You are a helpful assistant. Be concise.",
	messages: [
		{
			role: "user",
			content: "In one short sentence: what is the capital of France, and what is 7 times 8?",
			timestamp: 1789529142000,
		},
	],
};

const result = await complete(model, context, { apiKey: "replay" });

// Normalize volatile/opaque fields before comparison:
// - drop thinkingSignature (opaque JSON string; key order differs by language)
// - drop timestamps
const content = result.content.map((block) => {
	if (block.type === "thinking") {
		return { type: "thinking", thinking: block.thinking, redacted: block.redacted };
	}
	if (block.type === "text") {
		return { type: "text", text: block.text };
	}
	return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
});

console.log(
	JSON.stringify(
		{
			content,
			usage: {
				input: result.usage.input,
				output: result.usage.output,
				cacheRead: result.usage.cacheRead,
				cacheWrite: result.usage.cacheWrite,
				totalTokens: result.usage.totalTokens,
				cost: {
					input: result.usage.cost.input,
					output: result.usage.cost.output,
					cacheRead: result.usage.cost.cacheRead,
					cacheWrite: result.usage.cost.cacheWrite,
					total: result.usage.cost.total,
				},
			},
			stopReason: result.stopReason,
			responseModel: result.responseModel ?? null,
			responseId: result.responseId ?? null,
			errorMessage: result.errorMessage ?? null,
		},
		null,
		2,
	),
);
