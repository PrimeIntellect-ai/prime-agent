import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Usage } from "../src/types.js";
import { getKimiCodingTestModel } from "./kimi-test-model.js";
import { getZaiTestModel } from "./zai-test-model.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";

const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	const context1: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");

	const context2: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

describe("totalTokens field", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (API Key)", () => {
		it("claude-sonnet-4-5 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("anthropic", "claude-sonnet-4-5");

			console.log(`\nAnthropic / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.ANTHROPIC_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);

			const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
			expect(hasCache).toBe(true);
		});
	});

	describe("Anthropic (OAuth)", () => {
		it.skipIf(!anthropicOAuthToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("anthropic", "claude-sonnet-4-6");

				console.log(`\nAnthropic OAuth / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: anthropicOAuthToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions", () => {
		it("gpt-4o-mini - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
			void _compat;
			const llm: Model<"openai-completions"> = {
				...baseModel,
				api: "openai-completions",
			};

			console.log(`\nOpenAI Completions / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses", () => {
		it("gpt-4o - should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getModel("openai", "gpt-4o");

			console.log(`\nOpenAI Responses / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses", () => {
		it("gpt-4o-mini - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("azure-openai-responses", "gpt-4o-mini");
			const azureDeploymentName = resolveAzureDeploymentName(llm.id);
			const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

			console.log(`\nAzure OpenAI Responses / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, azureOptions);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google", () => {
		it("gemini-2.5-flash - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("google", "gemini-2.5-flash");

			console.log(`\nGoogle / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI", () => {
		it("grok-4.3 - should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getModel("xai", "grok-4.3");

			console.log(`\nxAI / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.XAI_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq", () => {
		it("openai/gpt-oss-120b - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("groq", "openai/gpt-oss-120b");

			console.log(`\nGroq / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.GROQ_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras", () => {
		it("gpt-oss-120b - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("cerebras", "gpt-oss-120b");

			console.log(`\nCerebras / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.CEREBRAS_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI", () => {
		it("@cf/moonshotai/kimi-k2.6 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

			console.log(`\nCloudflare Workers AI / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, {
				apiKey: process.env.CLOUDFLARE_API_KEY,
			});

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway", () => {
		it("workers-ai/@cf/moonshotai/kimi-k2.6 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

			console.log(`\nCloudflare AI Gateway / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, {
				apiKey: process.env.CLOUDFLARE_API_KEY,
			});

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face", () => {
		it("Kimi-K2.5 - should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

			console.log(`\nHugging Face / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.HF_TOKEN });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("z.ai", () => {
		it("should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getZaiTestModel();

			console.log(`\nz.ai / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.ZAI_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral", () => {
		it("devstral-medium-latest - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("mistral", "devstral-medium-latest");

			console.log(`\nMistral / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.MISTRAL_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax", () => {
		it("MiniMax-M2.7 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("minimax", "MiniMax-M2.7");

			console.log(`\nMiniMax / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.MINIMAX_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing)", () => {
		it("mimo-v2.5-pro - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("xiaomi", "mimo-v2.5-pro");

			console.log(`\nXiaomi MiMo / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.XIAOMI_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)("Xiaomi MiMo Token Plan (CN)", () => {
		it("mimo-v2.5-pro - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			console.log(`\nXiaomi MiMo Token Plan CN / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, {
				apiKey: process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
			});

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)("Xiaomi MiMo Token Plan (AMS)", () => {
		it("mimo-v2.5-pro - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			console.log(`\nXiaomi MiMo Token Plan AMS / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, {
				apiKey: process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY,
			});

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)("Xiaomi MiMo Token Plan (SGP)", () => {
		it("mimo-v2.5-pro - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			console.log(`\nXiaomi MiMo Token Plan SGP / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, {
				apiKey: process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY,
			});

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding", () => {
		it("should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getKimiCodingTestModel();

			console.log(`\nKimi For Coding / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.KIMI_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway", () => {
		it("google/gemini-2.5-flash - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

			console.log(`\nVercel AI Gateway / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.AI_GATEWAY_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter", () => {
		it("anthropic/claude-sonnet-4 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("openrouter", "anthropic/claude-sonnet-4");

			console.log(`\nOpenRouter / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});

		it("deepseek/deepseek-chat - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("openrouter", "deepseek/deepseek-chat");

			console.log(`\nOpenRouter / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});

		it("mistralai/mistral-small-3.2-24b-instruct - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("openrouter", "mistralai/mistral-small-3.2-24b-instruct");

			console.log(`\nOpenRouter / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});

		it("google/gemini-2.5-flash - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("openrouter", "google/gemini-2.5-flash");

			console.log(`\nOpenRouter / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});

		it("meta-llama/llama-4-scout - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("openrouter", "meta-llama/llama-4-scout");

			console.log(`\nOpenRouter / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe("GitHub Copilot (OAuth)", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-5-mini - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5-mini");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock", () => {
		it("claude-sonnet-4-5 - should return totalTokens equal to sum of components", {
			retry: 3,
			timeout: 60000,
		}, async () => {
			const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

			console.log(`\nAmazon Bedrock / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");

				console.log(`\nOpenAI Codex / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: openaiCodexToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});
});
