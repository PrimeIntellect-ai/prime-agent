import { type Api, type Model, parseOpenRouterModels } from "@earendil-works/pi-ai";

const URL = "https://openrouter.ai/api/v1/models?output_modalities=text";
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;
const BACKOFF_MS = 30_000;

let cached: { models: Model<Api>[]; fetchedAt: number } | undefined;
let inFlight: Promise<Model<Api>[] | undefined> | undefined;
let lastAttemptAt = 0;

export function resetOpenRouterModelCache(): void {
	cached = undefined;
	inFlight = undefined;
	lastAttemptAt = 0;
}

function catalogHasId(models: Model<Api>[] | undefined, id: string | undefined): boolean {
	return !id || (models?.some((model) => model.id === id) ?? false);
}

/** Live OpenRouter catalog with TTL, in-flight dedupe, and failure backoff. */
export async function getOpenRouterModels(
	fetchImpl: typeof fetch = globalThis.fetch,
	requireId?: string,
): Promise<Model<Api>[] | undefined> {
	const now = Date.now();
	if (cached && now - cached.fetchedAt < TTL_MS && catalogHasId(cached.models, requireId)) return cached.models;
	if (inFlight) return inFlight;
	if (now - lastAttemptAt < BACKOFF_MS && catalogHasId(cached?.models, requireId)) return cached?.models;
	lastAttemptAt = now;

	const run = async (): Promise<Model<Api>[] | undefined> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const response = await fetchImpl(URL, { signal: controller.signal });
			if (!response.ok) return cached?.models;
			const models = parseOpenRouterModels(await response.json());
			if (models.length === 0) return cached?.models;
			cached = { models, fetchedAt: Date.now() };
			return models;
		} catch {
			return cached?.models;
		} finally {
			clearTimeout(timer);
		}
	};
	const promise = run();
	inFlight = promise;
	void promise.finally(() => {
		if (inFlight === promise) inFlight = undefined;
	});
	return promise;
}
