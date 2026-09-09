import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";

export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function isModelCatalogOffline(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

export class ModelCatalogRequestError extends Error {
	constructor(readonly status: number) {
		super(`Model catalog request failed with status ${status}`);
	}
}

interface Snapshot<T> {
	scope: string;
	fetchedAt: number;
	etag?: string;
	payload: unknown;
	models: T;
}

async function readJsonResponse(response: Response): Promise<unknown> {
	if (!response.ok) throw new ModelCatalogRequestError(response.status);
	if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("Catalog is too large");
	if (!response.body) throw new Error("Catalog body is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("Catalog is too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

/** One last-good snapshot per source. Changing scope discards the previous account's view. */
export class ModelCatalogCache<T> {
	private snapshot?: Snapshot<T>;
	private scope?: string;
	private pending?: { scope: string; promise: Promise<T | undefined> };
	private lastAttempt?: number;
	private generation = 0;

	constructor(
		private readonly url: string,
		private readonly cachePath: string | undefined,
		private readonly parse: (payload: unknown, scope: string) => T,
	) {}

	get(scope: string): T | undefined {
		if (this.scope === scope) return this.snapshot?.models;
		this.scope = scope;
		this.generation++;
		this.pending = undefined;
		this.snapshot = undefined;
		this.lastAttempt = undefined;
		if (!this.cachePath) return undefined;
		try {
			const cached = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<Snapshot<T>> & { url?: unknown };
			if (
				cached.url !== this.url ||
				cached.scope !== scope ||
				typeof cached.fetchedAt !== "number" ||
				!Number.isFinite(cached.fetchedAt)
			)
				return undefined;
			this.snapshot = {
				scope,
				fetchedAt: cached.fetchedAt,
				etag: typeof cached.etag === "string" ? cached.etag : undefined,
				payload: cached.payload,
				models: this.parse(cached.payload, scope),
			};
		} catch {
			// Invalid or missing disk state falls back to the catalog bundled with the client.
		}
		return this.snapshot?.models;
	}

	clear(scope: string): void {
		if (this.scope !== scope) return;
		this.snapshot = undefined;
		try {
			if (this.cachePath) rmSync(this.cachePath, { force: true });
		} catch {
			/* Read-only cache directories do not prevent model discovery. */
		}
	}

	refresh(
		scope: string,
		options: {
			force?: boolean;
			headers?: Record<string, string>;
			fetchFn?: typeof fetch;
			isCurrent?: () => boolean;
		} = {},
	): Promise<T | undefined> {
		const cached = this.get(scope);
		if (isModelCatalogOffline()) return Promise.resolve(cached);
		if (this.pending?.scope === scope) return this.pending.promise;
		const checkedAt = this.lastAttempt ?? this.snapshot?.fetchedAt;
		if (
			!options.force &&
			checkedAt !== undefined &&
			Date.now() >= checkedAt &&
			Date.now() - checkedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS
		)
			return Promise.resolve(cached);
		this.lastAttempt = Date.now();
		const previous = this.snapshot;
		const generation = this.generation;
		const isCurrent = () => this.scope === scope && generation === this.generation && (options.isCurrent?.() ?? true);
		const promise = (async () => {
			try {
				const response = await (options.fetchFn ?? fetch)(this.url, {
					headers: {
						accept: "application/json",
						"cache-control": "no-cache",
						...options.headers,
						...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
					},
					signal: AbortSignal.timeout(5_000),
					redirect: "error",
				});
				const payload = response.status === 304 && previous ? previous.payload : await readJsonResponse(response);
				const models = response.status === 304 && previous ? previous.models : this.parse(payload, scope);
				if (!isCurrent()) return undefined;
				this.snapshot = {
					scope,
					fetchedAt: Date.now(),
					etag: response.headers.get("etag") ?? (response.status === 304 ? previous?.etag : undefined),
					payload,
					models,
				};
				try {
					if (this.cachePath) {
						mkdirSync(dirname(this.cachePath), { recursive: true });
						const { models: _models, ...stored } = this.snapshot;
						writeFileAtomicSync(this.cachePath, JSON.stringify({ url: this.url, ...stored }), { mode: 0o600 });
					}
				} catch {
					/* Keep the validated in-memory snapshot if persistence fails. */
				}
				return models;
			} catch (error) {
				if (
					isCurrent() &&
					scope !== "public" &&
					error instanceof ModelCatalogRequestError &&
					(error.status === 401 || error.status === 403)
				) {
					this.clear(scope);
					return undefined;
				}
				return isCurrent() ? this.snapshot?.models : undefined;
			}
		})();
		this.pending = { scope, promise };
		void promise.finally(() => {
			if (this.pending?.promise === promise) this.pending = undefined;
		});
		return promise;
	}
}
