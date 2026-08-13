import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.js";
import { REPETITION_GUARD_DISABLED_ENV } from "../src/utils/repetition-guard.js";
import type { StreamFailureInfo } from "../src/utils/stream-failure.js";

/**
 * End-to-end cover for #1029 against the real streamer: a provider that emits
 * `reasoning_content` deltas of a degenerate loop must be cut off rather than
 * streamed to completion.
 *
 * The unit tests in `repetition-guard.test.ts` cover detection itself. This
 * asserts the wiring: the stream terminates, it terminates as an error rather
 * than a clean `done`, and it stops well short of what the provider offered.
 */

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: [{ type: "text", text: "think about this" }] }],
	} as Context;
}

/** The exact unit from the incident transcript. */
const LOOP_UNIT = "The the the the the the the ";

/**
 * SSE endpoint that streams `chunks` reasoning deltas of the loop unit, then
 * finishes. Records how many it actually managed to write, so the test can
 * assert the guard cut the stream short.
 */
function startLoopingServer(chunks: number): { server: http.Server; sent: () => number } {
	let sent = 0;
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		for await (const _chunk of req) {
			// drain
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (let i = 0; i < chunks; i++) {
			const ok = res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-loop",
					object: "chat.completion.chunk",
					created: 0,
					model: "repro-model",
					choices: [{ index: 0, delta: { reasoning_content: LOOP_UNIT }, finish_reason: null }],
				})}\n\n`,
			);
			sent++;
			// `ok === false` is only backpressure, not a hangup: wait for drain
			// rather than truncating the response ourselves.
			if (res.writableEnded || res.destroyed) break;
			if (!ok) await once(res, "drain").catch(() => undefined);
		}
		if (!res.writableEnded) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-loop",
					object: "chat.completion.chunk",
					created: 0,
					model: "repro-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		}
	});
	return { server, sent: () => sent };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

async function runAgainstLoopingProvider(chunks: number): Promise<AssistantMessageEvent[]> {
	const { server } = startLoopingServer(chunks);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		return await collect(
			streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), buildContext(), { apiKey: "test-key" }),
		);
	} finally {
		server.close();
	}
}

describe("openai-completions repetition guard (#1029)", () => {
	const original = process.env[REPETITION_GUARD_DISABLED_ENV];

	afterEach(() => {
		if (original === undefined) delete process.env[REPETITION_GUARD_DISABLED_ENV];
		else process.env[REPETITION_GUARD_DISABLED_ENV] = original;
	});

	it("aborts a degenerate reasoning stream instead of consuming it", async () => {
		// 2,366 repeats is what the reported incident produced before the user
		// gave up and aborted by hand.
		const events = await runAgainstLoopingProvider(2366);

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") return;
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toContain("repeated");
	});

	it("stops far short of the whole degenerate response", async () => {
		const events = await runAgainstLoopingProvider(2366);

		const thinkingDeltas = events.filter((event) => event.type === "thinking_delta");
		const chars = thinkingDeltas.length * LOOP_UNIT.length;
		// The incident persisted 79,222 characters.
		expect(chars).toBeGreaterThan(0);
		expect(chars).toBeLessThan(20000);
	});

	it("classifies the failure as degenerate_output so it is not mistaken for a provider fault", async () => {
		const events = await runAgainstLoopingProvider(2366);

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") return;
		const diagnostics = terminal.error.diagnostics ?? [];
		const failure = diagnostics.find((entry) => entry.type === "provider_stream_failure");
		const details = failure?.details as StreamFailureInfo | undefined;
		expect(details?.kind).toBe("degenerate_output");
		expect(details?.providerErrorType).toMatch(/^repetition:/);
	});

	it("streams the whole response when the guard is disabled", async () => {
		process.env[REPETITION_GUARD_DISABLED_ENV] = "1";
		// Short enough to keep the test fast, long enough that the guard would
		// otherwise have fired well before the end.
		const events = await runAgainstLoopingProvider(600);

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		const thinkingDeltas = events.filter((event) => event.type === "thinking_delta");
		expect(thinkingDeltas.length).toBe(600);
	});
});
