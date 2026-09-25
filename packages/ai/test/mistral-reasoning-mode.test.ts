import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
	tools?: Array<{ type: "function"; function: { name: string; parameters: Record<string, unknown> } }>;
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const payloadCaptureModel: Model<"mistral-conversations"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const stream = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Mistral reasoning mode selection", () => {
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-small-2603")!, {
			reasoning: "medium",
		});

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Small 4 when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-small-2603")!);

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses prompt_mode for Magistral reasoning models", async () => {
		const payload = await capturePayload(
			getFixtureModel<"mistral-conversations">("mistral", "magistral-medium-latest")!,
			{
				reasoning: "medium",
			},
		);

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("uses reasoning_effort for Mistral Medium 3.5", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-medium-3.5")!, {
			reasoning: "medium",
		});

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Medium 3.5 when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"mistral-conversations">("mistral", "mistral-medium-3.5")!);

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});
});

describe("Mistral tool schema serialization", () => {
	it("strips TypeBox symbol keys before the SDK validates tool schemas", async () => {
		const model = {
			...getFixtureModel<"mistral-conversations">("mistral", "devstral-medium-latest")!,
			baseUrl: "http://127.0.0.1:9",
		} as Model<"mistral-conversations">;
		let capturedPayload: MistralPayload | undefined;

		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				tools: [
					{
						name: "inspect_schema",
						description: "Inspect the schema",
						parameters: Type.Object({ nested: Type.Object({ value: Type.String() }) }),
					},
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as MistralPayload;
					return payload;
				},
			},
		).result();

		const parameters = capturedPayload?.tools?.[0]?.function.parameters;
		const properties = parameters?.properties as Record<string, unknown> | undefined;
		expect(capturedPayload?.tools).toHaveLength(1);
		for (const value of [parameters, properties, properties?.nested]) {
			expect(value).toBeTruthy();
			expect(Object.getOwnPropertySymbols(value as object)).toHaveLength(0);
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("Input validation failed");
	});
});
