import { type Api, type Model, parseOpenRouterModels } from "@earendil-works/pi-ai";

const URL = "https://openrouter.ai/api/v1/models?output_modalities=text";
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;
const BACKOFF_MS = 30_000;

let cached: { models: Model<Api>[]; fetchedAt: number } | undefined;
let inFlight: Promise<Model<Api>[] | undefined> | undefined;
let lastAttemptAt = 0;
const recentlyMissingIds = new Map<string, number>();

export function resetOpenRouterModelCache(): void {
	cached = undefined;
	inFlight = undefined;
	lastAttemptAt = 0;
	recentlyMissingIds.clear();
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
	// A required id that a recent successful fetch did not contain stops forcing
	// refetches until the TTL elapses; otherwise a session pinned to a delisted
	// id would bypass the cache and backoff on every restore.
	const missingSince = requireId ? recentlyMissingIds.get(requireId) : undefined;
	const wantId = missingSince !== undefined && now - missingSince < TTL_MS ? undefined : requireId;

	if (cached && now - cached.fetchedAt < TTL_MS && catalogHasId(cached.models, wantId)) return cached.models;
	if (inFlight) {
		// A concurrent refresh was started without knowledge of wantId; use its
		// result when it suffices, otherwise fall through to a dedicated fetch.
		const models = await inFlight;
		if (catalogHasId(models, wantId)) return models;
	}
	if (now - lastAttemptAt < BACKOFF_MS && catalogHasId(cached?.models, wantId)) return cached?.models;
	lastAttemptAt = Date.now();

	const run = async (): Promise<Model<Api>[] | undefined> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const response = await fetchImpl(URL, { signal: controller.signal });
			if (!response.ok) return cached?.models;
			const models = parseOpenRouterModels(await response.json());
			if (models.length === 0) return cached?.models;
			cached = { models, fetchedAt: Date.now() };
			if (requireId && !catalogHasId(models, requireId)) recentlyMissingIds.set(requireId, Date.now());
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
