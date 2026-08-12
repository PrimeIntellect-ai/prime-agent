import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderNativeCompactionFunction,
	ProviderNativeCompactionOptions,
	ProviderNativeCompactionResult,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type ApiNativeCompactionFunction = (
	model: Model<Api>,
	context: Context,
	options: ProviderNativeCompactionOptions,
) => Promise<ProviderNativeCompactionResult>;

export interface ApiProvider<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
	TCompactionOptions extends ProviderNativeCompactionOptions = ProviderNativeCompactionOptions,
> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
	compact?: ProviderNativeCompactionFunction<TApi, TCompactionOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
	compact?: ApiNativeCompactionFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

function wrapNativeCompaction<TApi extends Api, TOptions extends ProviderNativeCompactionOptions>(
	api: TApi,
	compact: ProviderNativeCompactionFunction<TApi, TOptions>,
): ApiNativeCompactionFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return compact(model as Model<TApi>, context, options as TOptions);
	};
}

export function registerApiProvider<
	TApi extends Api,
	TOptions extends StreamOptions,
	TCompactionOptions extends ProviderNativeCompactionOptions,
>(provider: ApiProvider<TApi, TOptions, TCompactionOptions>, sourceId?: string): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
			compact: provider.compact ? wrapNativeCompaction(provider.api, provider.compact) : undefined,
		},
		sourceId,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
