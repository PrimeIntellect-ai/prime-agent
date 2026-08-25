import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";
import { workerStream, workerStreamSimple } from "./utils/stream-worker-pool.js";

export { getEnvApiKey } from "./env-api-keys.js";
export { isWorkerStreamEnabled } from "./utils/stream-worker-pool.js";

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const opts = (options ?? {}) as StreamOptions & Record<string, unknown>;
	const workerResult = workerStream(model, context, opts);
	if (workerResult) return workerResult;

	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, opts as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const opts = (options ?? {}) as StreamOptions & Record<string, unknown>;
	const workerResult = workerStreamSimple(model, context, opts);
	if (workerResult) return workerResult;

	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, opts);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
