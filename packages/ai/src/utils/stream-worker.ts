/**
 * Worker entry point for offloading AI provider stream parsing to worker_threads.
 *
 * Receives a stream request from the parent thread, imports the provider module,
 * runs the stream function, and posts each event back via parentPort.
 *
 * Abort: parent sends { type: "abort", id } → worker calls controller.abort().
 */
import { parentPort } from "node:worker_threads";
import * as anthropic from "../providers/anthropic.js";
import * as azureOpenaiResponses from "../providers/azure-openai-responses.js";
import * as google from "../providers/google.js";
import * as googleVertex from "../providers/google-vertex.js";
import * as mistral from "../providers/mistral.js";
import * as openaiCodexResponses from "../providers/openai-codex-responses.js";
import * as openaiCompletions from "../providers/openai-completions.js";
import * as openaiResponses from "../providers/openai-responses.js";
import type { Api, AssistantMessageEvent, Context, Model, StreamOptions } from "../types.js";

interface StreamRequest {
	type: "stream";
	id: number;
	api: Api;
	model: Model<Api>;
	context: Context;
	options: StreamOptions & Record<string, unknown>;
	useSimple: boolean;
}

interface AbortRequest {
	type: "abort";
	id: number;
}

type WorkerMessage = StreamRequest | AbortRequest;

interface ParentEvent {
	type: "event";
	id: number;
	event: AssistantMessageEvent;
}

interface ParentDone {
	type: "done";
	id: number;
}

interface ParentError {
	type: "error";
	id: number;
	error: string;
}

type ParentMessage = ParentEvent | ParentDone | ParentError | { type: "ready" };

if (!parentPort) {
	throw new Error("stream-worker must be spawned as a worker_thread");
}

const port = parentPort;

const abortControllers = new Map<number, AbortController>();

interface ProviderModule {
	stream: (
		model: Model<Api>,
		context: Context,
		options?: StreamOptions & Record<string, unknown>,
	) => AsyncIterable<AssistantMessageEvent>;
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: StreamOptions & Record<string, unknown>,
	) => AsyncIterable<AssistantMessageEvent>;
}

const providerModules = new Map<string, ProviderModule>();

function registerProviderModule(api: string, module: Record<string, unknown>): void {
	const entries = Object.entries(module);
	const streamEntry = entries.find(([k]) => k.startsWith("stream") && !k.startsWith("streamSimple") && k !== "stream");
	const simpleEntry = entries.find(([k]) => k.startsWith("streamSimple"));

	if (!streamEntry || typeof streamEntry[1] !== "function") {
		throw new Error(`Provider module for ${api} has no stream export`);
	}

	providerModules.set(api, {
		stream: streamEntry[1] as ProviderModule["stream"],
		streamSimple: (simpleEntry?.[1] ?? streamEntry[1]) as ProviderModule["streamSimple"],
	});
}

registerProviderModule("anthropic-messages", anthropic);
registerProviderModule("openai-completions", openaiCompletions);
registerProviderModule("openai-responses", openaiResponses);
registerProviderModule("azure-openai-responses", azureOpenaiResponses);
registerProviderModule("openai-codex-responses", openaiCodexResponses);
registerProviderModule("google-generative-ai", google);
registerProviderModule("google-vertex", googleVertex);
registerProviderModule("mistral-conversations", mistral);

function post(msg: ParentMessage): void {
	port.postMessage(msg);
}

async function handleStreamRequest(req: StreamRequest): Promise<void> {
	const { id, api, model, context, options, useSimple } = req;

	const abortController = new AbortController();
	abortControllers.set(id, abortController);

	const workerOptions = {
		...options,
		signal: abortController.signal,
		onPayload: undefined,
		onResponse: undefined,
	} as StreamOptions & Record<string, unknown>;

	try {
		const module = providerModules.get(api);
		if (!module) {
			throw new Error(`No provider module registered for api: ${api}`);
		}
		const fn = useSimple ? module.streamSimple : module.stream;
		const eventStream = fn(model, context, workerOptions);

		for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
			post({ type: "event", id, event });
		}

		post({ type: "done", id });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		post({ type: "error", id, error: message });
	} finally {
		abortControllers.delete(id);
	}
}

port.on("message", async (msg: WorkerMessage) => {
	if (msg.type === "abort") {
		const controller = abortControllers.get(msg.id);
		if (controller) controller.abort();
		return;
	}

	if (msg.type === "stream") {
		await handleStreamRequest(msg);
	}
});

port.on("messageerror", (error: Error) => {
	console.error("[stream-worker] message error:", error);
});

post({ type: "ready" });
