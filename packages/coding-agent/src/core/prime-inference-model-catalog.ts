import { Buffer } from "node:buffer";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
	type Api,
	isPrivatePrimeInferenceModelId,
	type Model,
	type OpenAICompletionsCompat,
	type PrimeInferenceCatalogEntry,
	parsePrimeInferenceModelCatalog,
} from "@earendil-works/pi-ai";

export const PRIME_INFERENCE_BASE_URL = "https://api.pinference.ai/api/v1";
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_CATALOG_COVERAGE = 0.5;
const pendingRefreshes = new Map<string, Promise<Model<"openai-completions">[] | undefined>>();

const DEFAULT_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	// The endpoint does not yet describe reasoning controls. Do not send an
	// unconfirmed reasoning_effort parameter for models without a bundled template.
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};

function cacheCosts(entry: PrimeInferenceCatalogEntry, template?: Model<"openai-completions">) {
	const anthropic = entry.id.toLowerCase().startsWith("anthropic/");
	return {
		cacheRead: entry.cacheRead ?? template?.cost.cacheRead ?? (anthropic ? entry.input * 0.1 : 0),
		cacheWrite: entry.cacheWrite ?? template?.cost.cacheWrite ?? (anthropic ? entry.input * 1.25 : 0),
	};
}

export function buildPrimeInferenceModels(
	bundledModels: readonly Model<"openai-completions">[],
	entries: readonly PrimeInferenceCatalogEntry[],
	options: { includePrivate?: boolean; minimumModels?: number } = {},
): Model<"openai-completions">[] | undefined {
	const bundled = new Map(bundledModels.map((model) => [model.id.toLowerCase(), model]));
	const models: Model<"openai-completions">[] = [];
	for (const entry of entries) {
		if (!options.includePrivate && isPrivatePrimeInferenceModelId(entry.id)) continue;
		const template = bundled.get(entry.id.toLowerCase());
		if (!template && (!entry.contextWindow || !entry.maxTokens || entry.reasoning === undefined)) continue;
		const contextWindow = entry.contextWindow ?? template?.contextWindow ?? 0;
		const maxTokens = Math.min(entry.maxTokens ?? template?.maxTokens ?? 0, contextWindow);
		models.push({
			id: entry.id,
			name: entry.name ?? template?.name ?? entry.id,
			api: "openai-completions",
			provider: "prime-inference",
			baseUrl: PRIME_INFERENCE_BASE_URL,
			reasoning: entry.reasoning ?? template?.reasoning ?? false,
			...(template?.thinkingLevelMap ? { thinkingLevelMap: { ...template.thinkingLevelMap } } : {}),
			input: (entry.vision ?? template?.input.includes("image")) ? ["text", "image"] : ["text"],
			cost: { input: entry.input, output: entry.output, ...cacheCosts(entry, template) },
			contextWindow,
			maxTokens,
			...(template?.featured ? { featured: true } : {}),
			compat: structuredClone(template?.compat ?? DEFAULT_COMPAT),
		});
	}
	const minimumModels = options.minimumModels ?? Math.ceil(bundledModels.length * MIN_CATALOG_COVERAGE);
	const coveredBundledModels = models.filter((model) => bundled.has(model.id.toLowerCase())).length;
	return coveredBundledModels >= minimumModels ? models : undefined;
}

export function mergePrimeInferenceModels(
	bundledModels: readonly Model<Api>[],
	livePrimeInferenceModels?: readonly Model<"openai-completions">[],
): Model<Api>[] {
	if (!livePrimeInferenceModels) return [...bundledModels];
	return [...bundledModels.filter((model) => model.provider !== "prime-inference"), ...livePrimeInferenceModels];
}

export function readCachedPrimeInferenceModels(
	cachePath: string,
	bundledModels: readonly Model<"openai-completions">[],
): Model<"openai-completions">[] | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		return buildPrimeInferenceModels(
			bundledModels,
			parsePrimeInferenceModelCatalog(JSON.parse(readFileSync(cachePath, "utf8")) as unknown),
		);
	} catch {
		return undefined;
	}
}

function writeCache(cachePath: string, value: unknown): void {
	const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, cachePath);
	} catch {
		// The bundled catalog remains available when the cache cannot be persisted.
	} finally {
		try {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		} catch {
			// Ignore cache cleanup failures.
		}
	}
}

export class PrimeInferenceCatalogRequestError extends Error {
	constructor(readonly status: number) {
		super(`Prime Inference model catalog request failed with status ${status}`);
	}
}

async function readResponse(response: Response): Promise<unknown> {
	if (!response.ok) throw new PrimeInferenceCatalogRequestError(response.status);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("Response is too large");
	if (!response.body) throw new Error("Response body is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw new Error("Response is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks, bytesRead).toString("utf8")) as unknown;
}

export async function fetchPrimeInferenceModelCatalog(
	options: { fetchFn?: typeof fetch; headers?: Record<string, string>; timeoutMs?: number; allowEmpty?: boolean } = {},
): Promise<{ payload: unknown; entries: PrimeInferenceCatalogEntry[] }> {
	const response = await (options.fetchFn ?? fetch)(`${PRIME_INFERENCE_BASE_URL}/models`, {
		headers: { accept: "application/json", ...options.headers },
		signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
	});
	const payload = await readResponse(response);
	return { payload, entries: parsePrimeInferenceModelCatalog(payload, { allowEmpty: options.allowEmpty }) };
}

export async function refreshPrimeInferenceModels(
	cachePath: string,
	bundledModels: readonly Model<"openai-completions">[],
	options: { fetchFn?: typeof fetch; offline?: boolean } = {},
): Promise<Model<"openai-completions">[] | undefined> {
	const cached = readCachedPrimeInferenceModels(cachePath, bundledModels);
	if (options.offline) return cached;
	const existing = pendingRefreshes.get(cachePath);
	if (existing) return existing;
	const promise = (async () => {
		try {
			const { payload, entries } = await fetchPrimeInferenceModelCatalog({ fetchFn: options.fetchFn });
			const models = buildPrimeInferenceModels(bundledModels, entries);
			if (!models) return cached;
			writeCache(cachePath, payload);
			return models;
		} catch {
			return cached;
		}
	})();
	pendingRefreshes.set(cachePath, promise);
	void promise.finally(() => {
		if (pendingRefreshes.get(cachePath) === promise) pendingRefreshes.delete(cachePath);
	});
	return promise;
}
