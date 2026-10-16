import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { getApiProviders, registerApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface DelegatedProviderOptions {
	socketPath: string;
	capability: string;
	maxFrameBytes?: number;
}

export function getDelegatedProviderOptionsFromEnvironment(): DelegatedProviderOptions | undefined {
	const socketPath = process.env.PRIME_PROVIDER_BROKER_SOCKET;
	const capability = process.env.PRIME_PROVIDER_BROKER_CAPABILITY;
	if (!socketPath && !capability) return undefined;
	if (!socketPath || !capability) throw new Error("Incomplete delegated provider broker configuration");
	return { socketPath, capability };
}

/** Override every currently registered provider API with the host adapter. */
export function installDelegatedProviderAdapters(options: DelegatedProviderOptions): void {
	const adapter = createDelegatedProviderAdapter(options);
	for (const provider of getApiProviders()) {
		registerApiProvider(
			{
				api: provider.api,
				stream: adapter.stream as typeof provider.stream,
				streamSimple: adapter.streamSimple as typeof provider.streamSimple,
			},
			"prime-delegated-provider-broker",
		);
	}
}

export interface DelegatedStreamRequest {
	type: "start";
	id: string;
	capability: string;
	model: { provider: string; api: string; id: string };
	context: Context;
	options: Pick<
		SimpleStreamOptions,
		| "temperature"
		| "maxTokens"
		| "transport"
		| "serviceTier"
		| "cacheRetention"
		| "sessionId"
		| "reasoning"
		| "thinkingBudgets"
	>;
}

type BrokerFrame =
	| { type: "event"; id: string; event: AssistantMessageEvent }
	| { type: "error"; id: string; message: string };

/**
 * Creates a Pi AI provider adapter that asks a trusted host over a Unix socket
 * to perform provider requests. Credentials and arbitrary request headers are
 * intentionally omitted from the wire format.
 */
export function createDelegatedProviderAdapter(options: DelegatedProviderOptions): {
	stream: StreamFunction;
	streamSimple: StreamFunction<Api, SimpleStreamOptions>;
} {
	if (!options.capability || Buffer.byteLength(options.capability) > 512) throw new Error("Invalid broker capability");
	const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;

	const delegate = (
		model: Model<Api>,
		context: Context,
		streamOptions?: StreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const id = randomUUID();
		const safeOptions: DelegatedStreamRequest["options"] = {};
		for (const key of [
			"temperature",
			"maxTokens",
			"transport",
			"serviceTier",
			"cacheRetention",
			"sessionId",
			"reasoning",
			"thinkingBudgets",
		] as const) {
			const value = (streamOptions as SimpleStreamOptions | undefined)?.[key];
			if (value !== undefined) (safeOptions as Record<string, unknown>)[key] = value;
		}
		const request: DelegatedStreamRequest = {
			type: "start",
			id,
			capability: options.capability,
			model: { provider: model.provider, api: model.api, id: model.id },
			context,
			options: safeOptions,
		};
		const payload = `${JSON.stringify(request)}\n`;
		if (Buffer.byteLength(payload) > maxFrameBytes) {
			emitError(stream, model, new Error("Delegated provider request is too large"));
			return stream;
		}

		const socket = createConnection(options.socketPath);
		let buffer = "";
		let completed = false;
		const fail = (error: Error) => {
			if (completed) return;
			completed = true;
			emitError(stream, model, error);
			socket.destroy();
		};
		const abort = () => socket.destroy(new Error("Provider request aborted"));
		if (streamOptions?.signal?.aborted) abort();
		else streamOptions?.signal?.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => socket.write(payload));
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (Buffer.byteLength(buffer) > maxFrameBytes && !buffer.includes("\n")) {
				fail(new Error("Delegated provider response frame is too large"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (Buffer.byteLength(line) > maxFrameBytes) {
					fail(new Error("Delegated provider response frame is too large"));
					return;
				}
				try {
					const frame = JSON.parse(line) as BrokerFrame;
					if (frame.id !== id) throw new Error("Mismatched delegated provider response");
					if (frame.type === "event") {
						stream.push(frame.event);
						if (frame.event.type === "done" || frame.event.type === "error") {
							completed = true;
							socket.end();
						}
					} else if (frame.type === "error") {
						fail(new Error(frame.message));
					}
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
					return;
				}
			}
		});
		socket.once("error", (error) => fail(error));
		socket.once("close", () => {
			streamOptions?.signal?.removeEventListener("abort", abort);
			if (!completed) fail(new Error("Delegated provider connection closed before completion"));
		});
		return stream;
	};

	return {
		stream: delegate,
		streamSimple: delegate as StreamFunction<Api, SimpleStreamOptions>,
	};
}

function emitError(stream: AssistantMessageEventStream, model: Model<Api>, error: Error): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: error.message.includes("aborted") ? "aborted" : "error",
		errorMessage: error.message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
}
