import { Buffer } from "node:buffer";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";

const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const MODEL_CATALOG_PATH = "model-catalog.json";
const MODEL_CATALOG_SCHEMA_VERSION = 1;
const MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 5_000;
const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_CATALOG_MODELS = 20_000;
const pendingRefreshes = new Map<string, Promise<Model<Api>[] | undefined>>();

interface ModelCatalogV1 {
	schemaVersion: 1;
	generatedAt: string;
	models: Model<Api>[];
}

interface CachedModelCatalog {
	url: string;
	fetchedAt: number;
	catalog: ModelCatalogV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedJsonObject(value: unknown, depth = 0): boolean {
	if (!isRecord(value) || depth > 10 || Object.keys(value).length > 100) return false;
	return Object.entries(value).every(([key, entry]) => {
		if (key.length > 128) return false;
		if (entry === null || typeof entry === "boolean") return true;
		if (typeof entry === "string") return entry.length <= 4_096;
		if (typeof entry === "number") return Number.isFinite(entry);
		if (Array.isArray(entry))
			return entry.length <= 100 && entry.every((item) => isBoundedJsonObject({ item }, depth + 1));
		return isBoundedJsonObject(entry, depth + 1);
	});
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isThinkingLevelMap(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || Object.keys(value).some((key) => !THINKING_LEVELS.has(key))) return false;
	return Object.values(value).every(
		(entry) => entry === null || (typeof entry === "string" && entry.length > 0 && entry.length <= 128),
	);
}

function isCatalogModel(value: unknown): value is Model<Api> {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		isNonEmptyString(value.id, 1_024) &&
		isNonEmptyString(value.name, 1_024) &&
		isNonEmptyString(value.api, 128) &&
		isNonEmptyString(value.provider, 128) &&
		typeof value.baseUrl === "string" &&
		value.baseUrl.length <= 2_048 &&
		typeof value.reasoning === "boolean" &&
		isThinkingLevelMap(value.thinkingLevelMap) &&
		Array.isArray(value.input) &&
		value.input.length > 0 &&
		value.input.length <= 2 &&
		value.input.every((item) => item === "text" || item === "image") &&
		isFiniteCost(value.cost.input) &&
		isFiniteCost(value.cost.output) &&
		isFiniteCost(value.cost.cacheRead) &&
		isFiniteCost(value.cost.cacheWrite) &&
		typeof value.contextWindow === "number" &&
		Number.isSafeInteger(value.contextWindow) &&
		value.contextWindow > 0 &&
		value.contextWindow <= 100_000_000 &&
		typeof value.maxTokens === "number" &&
		Number.isSafeInteger(value.maxTokens) &&
		value.maxTokens > 0 &&
		value.maxTokens <= 100_000_000 &&
		(value.featured === undefined || typeof value.featured === "boolean") &&
		(value.headers === undefined || isBoundedJsonObject(value.headers)) &&
		(value.compat === undefined || isBoundedJsonObject(value.compat))
	);
}

export function parseRemoteModelCatalog(value: unknown): ModelCatalogV1 {
	if (!isRecord(value) || value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
		throw new Error("Unsupported model catalog schema version");
	}
	if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
		throw new Error("Invalid model catalog timestamp");
	}
	if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_MODEL_CATALOG_MODELS) {
		throw new Error("Invalid model catalog model count");
	}
	const seen = new Set<string>();
	for (const model of value.models) {
		if (!isCatalogModel(model)) throw new Error("Invalid model catalog entry");
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) throw new Error(`Duplicate model catalog entry ${key}`);
		seen.add(key);
	}
	return value as unknown as ModelCatalogV1;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])]),
	);
}

function transportSignature(model: Model<Api>): string {
	return JSON.stringify(
		canonicalize({ api: model.api, baseUrl: model.baseUrl, headers: model.headers, compat: model.compat }),
	);
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
		compat: template.compat ? structuredClone(template.compat) : undefined,
	};
}

export function mergeRemoteModelCatalog(
	bundledModels: readonly Model<Api>[],
	remoteModels: readonly Model<Api>[] | undefined,
): Model<Api>[] {
	if (!remoteModels) return bundledModels.map((model) => structuredClone(model));
	const exact = new Map(bundledModels.map((model) => [`${model.provider}/${model.id}`, model]));
	const transports = new Map<string, Model<Api>>();
	for (const model of bundledModels) transports.set(`${model.provider}\0${transportSignature(model)}`, model);

	const merged = new Map(bundledModels.map((model) => [`${model.provider}/${model.id}`, structuredClone(model)]));
	for (const remote of remoteModels) {
		const key = `${remote.provider}/${remote.id}`;
		const template = exact.get(key) ?? transports.get(`${remote.provider}\0${transportSignature(remote)}`);
		if (template) merged.set(key, cloneTransport(template, remote));
	}
	return [...merged.values()];
}

export function getRemoteModelCatalogUrl(): string {
	const explicit = process.env.PRIME_AGENT_MODEL_CATALOG_URL?.trim();
	if (explicit) return explicit;
	const base = (process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim() || DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL).replace(
		/\/+$/,
		"",
	);
	return `${base}/${MODEL_CATALOG_PATH}`;
}

function readCache(cachePath: string, url: string): CachedModelCatalog | undefined {
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
		return { url, fetchedAt: value.fetchedAt, catalog: parseRemoteModelCatalog(value.catalog) };
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

export function readCachedRemoteModelCatalog(cachePath: string): Model<Api>[] | undefined {
	return readCache(cachePath, getRemoteModelCatalogUrl())?.catalog.models;
}

function offlineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
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
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_MODEL_CATALOG_BYTES)
		throw new Error("Model catalog response is too large");
	return parseRemoteModelCatalog(JSON.parse(text) as unknown);
}

export async function refreshRemoteModelCatalog(
	cachePath: string,
	options: { fetchFn?: typeof fetch; now?: number } = {},
): Promise<Model<Api>[] | undefined> {
	const url = getRemoteModelCatalogUrl();
	const now = options.now ?? Date.now();
	const cached = readCache(cachePath, url);
	if (cached && now - cached.fetchedAt < MODEL_CATALOG_CACHE_TTL_MS) return cached.catalog.models;
	if (offlineModeEnabled()) return cached?.catalog.models;

	const key = `${cachePath}\0${url}`;
	const existing = pendingRefreshes.get(key);
	if (existing) return existing;
	const promise = (async () => {
		try {
			const catalog = await fetchCatalog(url, options.fetchFn ?? fetch);
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
