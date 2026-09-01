import { Buffer } from "node:buffer";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { type Api, type Model, type ModelCatalogV1, parseModelCatalog } from "@earendil-works/pi-ai";
import { isTruthyEnvFlag } from "../utils/env.js";
import { getPrimeAgentDownloadBaseUrl } from "../utils/prime-agent-download.js";

const MODEL_CATALOG_PATH = "model-catalog.json";
const MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 5_000;
const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
const MIN_REMOTE_MODEL_CATALOG_COVERAGE = 0.5;
const pendingRefreshes = new Map<string, Promise<Model<Api>[] | undefined>>();

interface CachedModelCatalog {
	url: string;
	fetchedAt: number;
	catalog: ModelCatalogV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTransport(template: Model<Api>, remote: Model<Api>): Model<Api> {
	return {
		id: remote.id,
		name: remote.name,
		api: template.api,
		provider: remote.provider,
		baseUrl: template.baseUrl,
		reasoning: remote.reasoning,
		...(remote.thinkingLevelMap ? { thinkingLevelMap: { ...remote.thinkingLevelMap } } : {}),
		input: [...remote.input],
		cost: { ...remote.cost },
		contextWindow: remote.contextWindow,
		maxTokens: remote.maxTokens,
		...(remote.featured !== undefined ? { featured: remote.featured } : {}),
		headers: template.headers ? { ...template.headers } : undefined,
		compat: remote.compat ? structuredClone(remote.compat) : undefined,
	};
}

function modelKey(provider: string, id: string): string {
	return JSON.stringify([provider, id]);
}

function transportKey(model: Model<Api>): string {
	return `${model.provider}\0${model.api}\0${model.baseUrl}`;
}

export function getMinimumRemoteModelCatalogSize(bundledModelCount: number): number {
	return Math.ceil(bundledModelCount * MIN_REMOTE_MODEL_CATALOG_COVERAGE);
}

export function mergeRemoteModelCatalog(
	bundledModels: readonly Model<Api>[],
	remoteModels: readonly Model<Api>[] | undefined,
): Model<Api>[] {
	if (!remoteModels) return bundledModels.map((model) => structuredClone(model));
	const exact = new Map(bundledModels.map((model) => [modelKey(model.provider, model.id), model]));
	const transports = new Map<string, Model<Api>>();
	for (const model of bundledModels) {
		const key = transportKey(model);
		const current = transports.get(key);
		if (!current || model.id < current.id) transports.set(key, model);
	}

	const merged: Model<Api>[] = [];
	for (const remote of remoteModels) {
		const key = modelKey(remote.provider, remote.id);
		const exactTemplate = exact.get(key);
		const template =
			exactTemplate && exactTemplate.api === remote.api && exactTemplate.baseUrl === remote.baseUrl
				? exactTemplate
				: transports.get(transportKey(remote));
		if (template) merged.push(cloneTransport(template, remote));
	}
	const minimumModels = getMinimumRemoteModelCatalogSize(bundledModels.length);
	return merged.length >= minimumModels ? merged : bundledModels.map((model) => structuredClone(model));
}

export function getRemoteModelCatalogUrl(): string {
	const explicit = process.env.PRIME_AGENT_MODEL_CATALOG_URL?.trim();
	const url = explicit || `${getPrimeAgentDownloadBaseUrl()}/${MODEL_CATALOG_PATH}`;
	if (new URL(url).protocol !== "https:") throw new Error("Model catalog URL must use HTTPS");
	return url;
}

function readCache(cachePath: string, url: string, minimumModels = 1): CachedModelCatalog | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		const value = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
		if (
			!isRecord(value) ||
			value.url !== url ||
			typeof value.fetchedAt !== "number" ||
			!Number.isFinite(value.fetchedAt)
		)
			return undefined;
		const catalog = parseModelCatalog(value.catalog, { skipInvalidModels: true });
		if (catalog.models.length < minimumModels) return undefined;
		return { url, fetchedAt: value.fetchedAt, catalog };
	} catch {
		return undefined;
	}
}

function writeCache(cachePath: string, cache: CachedModelCatalog): void {
	const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
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

export function readCachedRemoteModelCatalog(cachePath: string, minimumModels = 1): Model<Api>[] | undefined {
	try {
		return readCache(cachePath, getRemoteModelCatalogUrl(), minimumModels)?.catalog.models;
	} catch {
		return undefined;
	}
}

async function fetchCatalog(url: string, fetchFn: typeof fetch): Promise<ModelCatalogV1> {
	const response = await fetchFn(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Model catalog request failed with status ${response.status}`);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_MODEL_CATALOG_BYTES) {
		throw new Error("Model catalog response is too large");
	}
	if (!response.body) throw new Error("Model catalog response body is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > MAX_MODEL_CATALOG_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// Ignore cancellation errors and reject the oversized response.
				}
				throw new Error("Model catalog response is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks, bytesRead).toString("utf8");
	return parseModelCatalog(JSON.parse(text) as unknown, { skipInvalidModels: true });
}

export async function refreshRemoteModelCatalog(
	cachePath: string,
	options: { fetchFn?: typeof fetch; minimumModels?: number; now?: number } = {},
): Promise<Model<Api>[] | undefined> {
	let url: string;
	try {
		url = getRemoteModelCatalogUrl();
	} catch {
		return undefined;
	}
	const now = options.now ?? Date.now();
	const minimumModels = options.minimumModels ?? 1;
	const cached = readCache(cachePath, url, minimumModels);
	if (cached && now - cached.fetchedAt < MODEL_CATALOG_CACHE_TTL_MS) return cached.catalog.models;
	if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return cached?.catalog.models;

	const key = `${cachePath}\0${url}`;
	const existing = pendingRefreshes.get(key);
	if (existing) return existing;
	const promise = (async () => {
		try {
			const catalog = await fetchCatalog(url, options.fetchFn ?? fetch);
			if (catalog.models.length < minimumModels) throw new Error("Model catalog has too few compatible entries");
			writeCache(cachePath, { url, fetchedAt: now, catalog });
			return catalog.models;
		} catch {
			return cached?.catalog.models;
		}
	})();
	pendingRefreshes.set(key, promise);
	void promise.finally(() => {
		if (pendingRefreshes.get(key) === promise) pendingRefreshes.delete(key);
	});
	return promise;
}
