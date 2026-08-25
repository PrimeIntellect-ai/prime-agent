/**
 * Stream worker pool: offloads AI provider stream parsing to worker_threads.
 *
 * When enabled (PI_STREAM_WORKERS=1), each stream() / streamSimple() call is
 * routed to a worker thread. The worker handles fetch + SSE parsing + JSON.parse,
 * posting events back to the main thread. This frees the main event loop from
 * the CPU cost of parsing concurrent SSE streams.
 *
 * Limitations when enabled:
 * - onPayload / onResponse callbacks are not invoked (they cannot cross thread boundaries)
 * - Bedrock provider is not supported (uses AWS SDK with credential resolution that must stay on main thread)
 *
 * If no worker is available or the provider is unsupported, falls back to inline streaming.
 */

import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import type { Api, AssistantMessageEvent, Context, Model, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "./event-stream.js";

const POOL_SIZE = (() => {
	const raw = process.env.PI_STREAM_WORKERS;
	if (raw === "1" || raw === "true") {
		return Math.max(1, Math.min(8, (cpus().length ?? 4) - 1));
	}
	if (raw && /^\d+$/.test(raw)) {
		return Math.max(1, Math.min(16, Number.parseInt(raw, 10)));
	}
	return 0; // disabled
})();

const UNSUPPORTED_APIS = new Set<string>(["bedrock-converse-stream"]);

interface WorkerHandle {
	worker: Worker;
	busy: boolean;
	ready: Promise<void>;
}

let pool: WorkerHandle[] = [];
let nextRequestId = 0;

function ensurePool(): void {
	if (pool.length > 0 || POOL_SIZE === 0) return;

	if (process.env.PI_STREAM_WORKERS_DEBUG === "1") {
		console.error(`[stream-worker-pool] initializing pool of ${POOL_SIZE} workers`);
	}

	for (let i = 0; i < POOL_SIZE; i++) {
		const worker = new Worker(new URL("./stream-worker.js", import.meta.url));
		let readyResolve: () => void;
		const ready = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});

		worker.once("message", function onReady(msg: { type: string }) {
			if (msg.type === "ready") {
				readyResolve();
			}
		});

		worker.on("error", (error) => {
			console.error("[stream-worker-pool] worker error:", error);
		});

		pool.push({ worker, busy: false, ready });
	}
}

function acquireWorker(): WorkerHandle | undefined {
	ensurePool();
	return pool.find((w) => !w.busy);
}

interface StreamRequestMessage {
	type: "stream";
	id: number;
	api: Api;
	model: Model<Api>;
	context: Context;
	options: StreamOptions & Record<string, unknown>;
	useSimple: boolean;
}

interface StreamEventMessage {
	type: "event";
	id: number;
	event: AssistantMessageEvent;
}

interface StreamDoneMessage {
	type: "done";
	id: number;
}

interface StreamErrorMessage {
	type: "error";
	id: number;
	error: string;
}

type StreamResponseMessage = StreamEventMessage | StreamDoneMessage | StreamErrorMessage;

function runStreamInWorker(
	handle: WorkerHandle,
	api: Api,
	model: Model<Api>,
	context: Context,
	options: StreamOptions & Record<string, unknown>,
	useSimple: boolean,
	abortSignal?: AbortSignal,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const id = nextRequestId++;

	handle.busy = true;

	const messageHandler = (msg: StreamResponseMessage) => {
		if (msg.id !== id) return;

		if (msg.type === "event") {
			outer.push(msg.event);
		} else if (msg.type === "done") {
			handle.worker.off("message", messageHandler);
			handle.busy = false;
			outer.end();
		} else if (msg.type === "error") {
			handle.worker.off("message", messageHandler);
			handle.busy = false;
			const errorEvent: AssistantMessageEvent = {
				type: "error",
				reason: "error",
				error: {
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
					stopReason: "error",
					errorMessage: msg.error,
					timestamp: Date.now(),
				},
			};
			outer.push(errorEvent);
			outer.end(errorEvent.error);
		}
	};

	handle.worker.on("message", messageHandler);

	const request: StreamRequestMessage = { type: "stream", id, api, model, context, options, useSimple };
	handle.worker.postMessage(request);

	// Handle abort: forward to worker
	if (abortSignal) {
		const onAbort = () => {
			handle.worker.postMessage({ type: "abort", id });
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
	}

	return outer;
}

export function isWorkerStreamEnabled(): boolean {
	return POOL_SIZE > 0;
}

export function canWorkerStream(api: Api, _options: StreamOptions & Record<string, unknown>): boolean {
	if (POOL_SIZE === 0) return false;
	if (UNSUPPORTED_APIS.has(api)) return false;
	// onPayload/onResponse callbacks are stripped in the worker — extensions hooks
	// won't fire when worker streaming is active. This is an acceptable tradeoff
	// for the CPU relief the worker pool provides.
	return true;
}

/**
 * Strip non-serializable fields from Context before sending to worker.
 * Tool.execute functions can't cross postMessage boundary — providers only
 * need the tool schema (name, description, parameters) for the API request,
 * not the execute function.
 */
function sanitizeContextForWorker(context: Context): Context {
	if (!context.tools) {
		return { systemPrompt: context.systemPrompt, messages: context.messages };
	}
	return {
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		})),
	};
}

/**
 * Strip non-serializable fields from options before sending to worker.
 * Functions (onPayload, onResponse, signal) can't cross postMessage.
 */
function sanitizeOptionsForWorker(
	options: StreamOptions & Record<string, unknown>,
): StreamOptions & Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (typeof value === "function") continue;
		if (key === "signal") continue;
		result[key] = value;
	}
	return result as StreamOptions & Record<string, unknown>;
}

export function workerStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: StreamOptions & Record<string, unknown>,
): AssistantMessageEventStream | undefined {
	if (!canWorkerStream(model.api, options)) return undefined;

	const handle = acquireWorker();
	if (!handle) return undefined;

	const workerContext = sanitizeContextForWorker(context);
	const workerOptions = sanitizeOptionsForWorker(options);
	const abortSignal = options.signal as AbortSignal | undefined;

	return runStreamInWorker(handle, model.api, model, workerContext, workerOptions, false, abortSignal);
}

export function workerStreamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: StreamOptions & Record<string, unknown>,
): AssistantMessageEventStream | undefined {
	if (!canWorkerStream(model.api, options)) return undefined;

	const handle = acquireWorker();
	if (!handle) return undefined;

	const workerContext = sanitizeContextForWorker(context);
	const workerOptions = sanitizeOptionsForWorker(options);
	const abortSignal = options.signal as AbortSignal | undefined;

	return runStreamInWorker(handle, model.api, model, workerContext, workerOptions, true, abortSignal);
}

export async function drainWorkerPool(): Promise<void> {
	await Promise.all(pool.map((h) => h.ready));
	for (const handle of pool) {
		handle.worker.terminate();
	}
	pool = [];
}
