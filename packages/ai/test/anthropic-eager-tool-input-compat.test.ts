import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, Tool } from "../src/types.js";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

function createContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	compat: Model<"anthropic-messages">["compat"],
	context: Context,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`, compat), context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function getFirstTool(body: Record<string, unknown>): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools) || typeof tools[0] !== "object" || tools[0] === null) {
		throw new Error("Expected first tool in request body");
	}
	return tools[0] as Record<string, unknown>;
}

function getInputSchema(body: Record<string, unknown>): Record<string, unknown> {
	const inputSchema = getFirstTool(body).input_schema;
	if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
		throw new Error("Expected input schema on first tool");
	}
	return inputSchema as Record<string, unknown>;
}

describe("Anthropic eager tool input streaming compatibility", () => {
	it("sends per-tool eager_input_streaming by default", async () => {
		const request = await captureAnthropicRequest(undefined, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBe(true);
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});

	it("uses the legacy fine-grained tool streaming beta when eager tool input streaming is disabled", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
	});

	it("does not send the legacy fine-grained tool streaming beta when there are no tools", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext([]));

		expect(request.body.tools).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});
});

describe("Anthropic tool schema compatibility", () => {
	it("normalizes catch-all record patterns to additionalProperties recursively", async () => {
		const parameters = Type.Object({
			metadata: Type.Record(Type.String(), Type.Unknown()),
			labels: Type.Record(Type.String(), Type.String()),
			nested: Type.Array(Type.Record(Type.String(), Type.Number())),
		});
		const request = await captureAnthropicRequest(
			undefined,
			createContext([
				{
					name: "report",
					description: "Report metadata",
					parameters,
				},
			]),
		);
		const properties = getInputSchema(request.body).properties as Record<string, unknown>;

		expect(properties.metadata).toEqual({ type: "object", additionalProperties: true });
		expect(properties.labels).toEqual({ type: "object", additionalProperties: { type: "string" } });
		expect(properties.nested).toEqual({
			type: "array",
			items: { type: "object", additionalProperties: { type: "number" } },
		});
		expect(parameters.properties.metadata).toHaveProperty("patternProperties");
	});

	it("preserves non-catch-all patternProperties", async () => {
		const request = await captureAnthropicRequest(
			undefined,
			createContext([
				{
					name: "report",
					description: "Report metadata",
					parameters: Type.Object({
						metadata: Type.Unsafe({
							type: "object",
							patternProperties: { "^x-": Type.String() },
						}),
					}),
				},
			]),
		);
		const properties = getInputSchema(request.body).properties as Record<string, unknown>;

		expect(properties.metadata).toEqual({
			type: "object",
			patternProperties: { "^x-": { type: "string" } },
		});
	});

	it("preserves catch-all patternProperties when named properties share the schema", async () => {
		const request = await captureAnthropicRequest(
			undefined,
			createContext([
				{
					name: "report",
					description: "Report metadata",
					parameters: Type.Object({
						metadata: Type.Unsafe({
							type: "object",
							properties: { fixed: Type.String() },
							patternProperties: { "^.*$": Type.Number() },
						}),
					}),
				},
			]),
		);
		const properties = getInputSchema(request.body).properties as Record<string, unknown>;

		expect(properties.metadata).toEqual({
			type: "object",
			properties: { fixed: { type: "string" } },
			patternProperties: { "^.*$": { type: "number" } },
		});
	});

	it("normalizes a record used as the root tool schema", async () => {
		const request = await captureAnthropicRequest(
			undefined,
			createContext([
				{
					name: "labels",
					description: "Submit labels",
					parameters: Type.Record(Type.String(), Type.String()),
				},
			]),
		);

		expect(getInputSchema(request.body)).toEqual({
			type: "object",
			additionalProperties: { type: "string" },
			properties: {},
			required: [],
		});
	});

	it("does not forward root schema metadata", async () => {
		const request = await captureAnthropicRequest(
			undefined,
			createContext([
				{
					name: "labels",
					description: "Submit labels",
					parameters: Type.Unsafe({
						$schema: "https://json-schema.org/draft/2020-12/schema",
						$defs: { label: Type.String() },
						definitions: { legacyLabel: Type.String() },
						type: "object",
						properties: { label: Type.String() },
						required: ["label"],
						additionalProperties: false,
					}),
				},
			]),
		);

		expect(getInputSchema(request.body)).toEqual({
			type: "object",
			properties: { label: { type: "string" } },
			required: ["label"],
			additionalProperties: false,
		});
	});
});
