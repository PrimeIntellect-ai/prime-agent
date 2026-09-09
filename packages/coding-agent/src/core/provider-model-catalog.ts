import { type Api, type Model, parseModelCatalog } from "@earendil-works/pi-ai";

export const PROVIDER_MODEL_CATALOG_URL =
	"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/catalog/models.v1.json";

/** Catalog data can select installed transports, but cannot change where credentials are sent. */
export function parseProviderModelCatalog(payload: unknown, bundledModels: readonly Model<Api>[]): Model<Api>[] {
	const transports = new Map(
		bundledModels.map((model) => [JSON.stringify([model.provider, model.api, model.baseUrl]), model]),
	);
	const exact = new Map(bundledModels.map((model) => [JSON.stringify([model.provider, model.id]), model]));
	const catalog = parseModelCatalog(payload, { skipInvalidModels: true });
	const models: Model<Api>[] = [];
	for (const model of catalog.models) {
		if (model.provider === "prime-inference") continue;
		const transport = transports.get(JSON.stringify([model.provider, model.api, model.baseUrl]));
		if (!transport) continue;
		const template = exact.get(JSON.stringify([model.provider, model.id]));
		models.push({
			...model,
			api: transport.api,
			baseUrl: transport.baseUrl,
			headers: template?.headers ?? transport.headers,
		});
	}
	if (models.length === 0) throw new Error("Catalog has no models supported by this client");
	return models;
}
