import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import type { Context, StreamOptions } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

interface CapturedAzureClientOptions {
	apiKey: string;
	apiVersion: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
	baseURL: string;
}

const azureMock = vi.hoisted(() => ({
	constructorCalls: [] as CapturedAzureClientOptions[],
	createCalls: [] as unknown[],
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: (params: unknown) => {
				azureMock.createCalls.push(params);
				throw new Error("mock create");
			},
		};

		constructor(config: CapturedAzureClientOptions) {
			azureMock.constructorCalls.push(config);
		}
	}

	return { AzureOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const azureEnvVars = [
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_API_KEY",
] as const;
const originalEnv = Object.fromEntries(azureEnvVars.map((name) => [name, process.env[name]]));

beforeEach(() => {
	azureMock.constructorCalls.length = 0;
	azureMock.createCalls.length = 0;
	for (const name of azureEnvVars) delete process.env[name];
});

afterEach(() => {
	for (const name of azureEnvVars) {
		const value = originalEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function streamOnce(options: StreamOptions = {}) {
	return streamAzureOpenAIResponses(getFixtureModel("azure-openai-responses", "gpt-4o-mini"), context, {
		apiKey: "test-api-key",
		...options,
	}).result();
}

describe("azure-openai-responses base URL normalization", () => {
	it.each([
		[
			"cognitive services root",
			"https://res.cognitiveservices.azure.com",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		["azure openai root", "https://res.openai.azure.com", "https://res.openai.azure.com/openai/v1"],
		[
			"/openai path",
			"https://res.cognitiveservices.azure.com/openai",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		[
			"/openai/v1 path",
			"https://res.cognitiveservices.azure.com/openai/v1",
			"https://res.cognitiveservices.azure.com/openai/v1",
		],
		["non-azure proxy path", "https://my-proxy.example.com/v1", "https://my-proxy.example.com/v1"],
		[
			"azure query params",
			"https://res.openai.azure.com/openai?api-version=2024-12-01",
			"https://res.openai.azure.com/openai/v1",
		],
		[
			"non-azure query params",
			"https://my-proxy.example.com/v1?custom=true",
			"https://my-proxy.example.com/v1?custom=true",
		],
	])("normalizes %s", async (_name, baseUrl, expected) => {
		process.env.AZURE_OPENAI_BASE_URL = baseUrl;

		await streamOnce();

		expect(azureMock.constructorCalls).toHaveLength(1);
		expect(azureMock.constructorCalls[0].baseURL).toBe(expected);
	});

	it("builds the default URL from AZURE_OPENAI_RESOURCE_NAME", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";

		await streamOnce();

		expect(azureMock.constructorCalls[0].baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("fails the stream on an invalid base URL", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "not-a-url";

		const result = await streamOnce();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Azure OpenAI base URL");
	});
});

it.each([
	[undefined, "session-1"],
	["none", undefined],
] as const)("sends store: false and honors cacheRetention=%s", async (cacheRetention, key) => {
	process.env.AZURE_OPENAI_RESOURCE_NAME = "res";
	await streamOnce({ sessionId: "session-1", cacheRetention });
	expect(azureMock.createCalls).toMatchObject([{ store: false, prompt_cache_key: key }]);
});
