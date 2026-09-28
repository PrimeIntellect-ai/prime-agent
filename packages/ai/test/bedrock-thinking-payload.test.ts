import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

beforeEach(() => vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", ""));
afterEach(() => vi.unstubAllEnvs());

interface BedrockThinkingPayload extends Pick<ConverseStreamCommandInput, "system" | "messages"> {
	inferenceConfig?: { maxTokens?: number; temperature?: number };
	additionalModelRequestFields?: {
		thinking?: { type: string; budget_tokens?: number; display?: string };
		output_config?: { effort?: string };
		anthropic_beta?: string[];
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "You are helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		...options,
		reasoning: options?.reasoning ?? "high",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			return payload;
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

describe("Bedrock thinking payload", () => {
	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const baseModel = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const model = getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-opus-4-7")!;

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("clamps xhigh reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const model = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.6 (adaptive)", async () => {
		const model = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;

		const payload = await capturePayload(model, { reasoning: "max" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});

	it("uses adaptive thinking with effort for Claude Fable 5", async () => {
		const model = getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-fable-5")!;

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
	});

	it("drops temperature for Claude Fable 5 (sampling params are rejected)", async () => {
		const model = getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-fable-5")!;

		const payload = await capturePayload(model, { reasoning: "high", temperature: 0.5 });

		expect(payload.inferenceConfig?.temperature).toBeUndefined();
	});

	it("omits display for GovCloud model ids on non-adaptive Claude thinking", async () => {
		const baseModel = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		)!;
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (GovCloud)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});

	it("omits display for GovCloud regions on adaptive Claude thinking", async () => {
		const baseModel = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-7-v1",
			name: "Claude Opus 4.7 (Global)",
		};

		const payload = await capturePayload(model, { region: "us-gov-west-1" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

describe("Application inference profile support", () => {
	it("uses adaptive thinking when model.name contains the model name but ARN does not", async () => {
		const baseModel = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Opus 4.6",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});

	it.each([
		["us.anthropic.claude-opus-5", "Claude Opus 5", "short", true],
		["us.anthropic.claude-opus-5-5", "Claude Opus 5.5", "long", true],
		["eu.anthropic.claude-sonnet-5", "Claude Sonnet 5", "short", true],
		["global.anthropic.claude-fable-5", "Claude Fable 5", "short", true],
		["us.anthropic.claude-fable-5-1", "Claude Fable 5.1", "long", true],
		["us.anthropic.claude-mythos-5", "Claude Mythos 5", "short", true],
		["us.anthropic.claude-mythos-5-1", "Claude Mythos 5.1", "short", true],
		["us.anthropic.claude-mythos-preview", "Claude Mythos Preview", "short", true],
		["us.anthropic.claude-opus-5-5", "Claude Opus 5.5", "none", false],
		["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "Claude Sonnet 4.5", "long", true],
		["us.anthropic.claude-3-7-sonnet-20250219-v1:0", "Claude 3.7 Sonnet", "short", true],
		["us.anthropic.claude-3-5-haiku-20241022-v1:0", "Claude 3.5 Haiku", "short", true],
		["us.anthropic.claude-3-sonnet-20240229-v1:0", "Claude 3 Sonnet", "short", false],
		["us.anthropic.claude-opus-5-v1:0", "profile", "short", true],
		["custom-profile", "Claude Fable 5.1 (Global)", "long", true],
		["us.anthropic.claude-opus-50", "Claude Opus 50", "short", false],
		["us.anthropic.claude-opus-5-99", "Claude Opus 5.99", "short", false],
		["amazon.nova-pro-v1:0", "Nova Pro", "short", false],
		["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test", "Claude Sonnet 4.6", "short", true],
		["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test", "Claude Fable 5.1", "short", true],
	] as const)("#2548: cache checkpoints for %s (%s, %s)", async (id, name, cacheRetention, enabled) => {
		const base = getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1")!;
		const payload = await capturePayload({ ...base, id, name }, { cacheRetention });
		const checkpoints = [...payload.system!, ...payload.messages!.flatMap((message) => message.content ?? [])].filter(
			(block) => block.cachePoint,
		);
		const point = { cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) } };
		expect(checkpoints).toEqual(enabled ? [point, point] : []);
	});

	it("falls back to fixed-budget thinking for non-adaptive Claude via model.name", async () => {
		const baseModel = getFixtureModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		)!;
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.5",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: expect.any(Number),
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});
});

describe("Bedrock endpoint resolution", () => {
	const awsEnvVars = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"] as const;
	const originalEnv = Object.fromEntries(awsEnvVars.map((name) => [name, process.env[name]]));

	beforeEach(() => {
		bedrockMock.constructorCalls.length = 0;
		for (const name of awsEnvVars) delete process.env[name];
	});

	afterEach(() => {
		for (const name of awsEnvVars) {
			const value = originalEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("assigns eu-central-1 runtime URLs to built-in EU inference profiles", () => {
		expect(
			getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0")!
				.baseUrl,
		).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});

	it.each([
		{
			name: "does not pin standard AWS endpoints when AWS_REGION is configured",
			env: "us-east-2",
			modelId: "us.anthropic.claude-opus-4-7" as const,
			baseUrl: undefined,
			endpoint: undefined,
			region: "us-east-2",
		},
		{
			name: "derives the region from a built-in EU endpoint when nothing is configured",
			env: undefined,
			modelId: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" as const,
			baseUrl: undefined,
			endpoint: "https://bedrock-runtime.eu-central-1.amazonaws.com",
			region: "eu-central-1",
		},
		{
			name: "passes custom Bedrock endpoints through to the SDK client",
			env: "us-west-2",
			modelId: "us.anthropic.claude-opus-4-7" as const,
			baseUrl: "https://bedrock-vpc.example.com",
			endpoint: "https://bedrock-vpc.example.com",
			region: "us-west-2",
		},
	])("$name", async ({ env, modelId, baseUrl, endpoint, region }) => {
		if (env) process.env.AWS_REGION = env;
		const baseModel = getFixtureModel<"bedrock-converse-stream">("amazon-bedrock", modelId)!;
		const model: Model<"bedrock-converse-stream"> = baseUrl ? { ...baseModel, baseUrl } : baseModel;

		await streamBedrock(model, makeContext(), { cacheRetention: "none" }).result();

		expect(bedrockMock.constructorCalls).toHaveLength(1);
		expect(bedrockMock.constructorCalls[0].endpoint).toBe(endpoint);
		expect(bedrockMock.constructorCalls[0].region).toBe(region);
	});
});
