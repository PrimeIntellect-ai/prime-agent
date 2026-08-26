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

export { getEnvApiKey } from "./env-api-keys.js";

const EXPLICIT_REQUEST_ACCESS_APIS = new Set<Api>([
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
]);

export function supportsExplicitRequestAccess(api: Api): boolean {
	return EXPLICIT_REQUEST_ACCESS_APIS.has(api) || api === "faux" || api.startsWith("faux-");
}

function assertExplicitRequestAccess(model: Model<Api>, options: StreamOptions | undefined): void {
	if (options?.disableEnvApiKey !== true) return;
	if (!supportsExplicitRequestAccess(model.api)) {
		throw new Error(`Run-scoped requests do not support api: ${model.api}`);
	}
	if (/\{CLOUDFLARE_[A-Z0-9_]+\}/.test(model.baseUrl)) {
		throw new Error(`Run-scoped request requires a resolved Cloudflare endpoint for provider: ${model.provider}`);
	}
	let endpoint: URL;
	try {
		endpoint = new URL(model.baseUrl);
	} catch {
		throw new Error(`Run-scoped request requires an explicit HTTP endpoint for provider: ${model.provider}`);
	}
	if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username !== "" || endpoint.password !== "") {
		throw new Error(`Run-scoped request requires an explicit HTTP endpoint for provider: ${model.provider}`);
	}
	if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
		throw new Error(`Run-scoped request requires explicit access for provider: ${model.provider}`);
	}
}

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
	assertExplicitRequestAccess(model, options);
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
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
	assertExplicitRequestAccess(model, options);
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
