import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS, ModelCatalogCache } from "../src/core/model-catalog-cache.js";

const directories: string[] = [];
const url = "https://catalog.example/models";
function cachePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "catalog-cache-"));
	directories.push(directory);
	return join(directory, "cache.json");
}
function parse(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Invalid catalog");
	return value;
}
const response = (models: string[], etag?: string) =>
	new Response(JSON.stringify(models), { headers: etag ? { etag } : {} });

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model catalog cache", () => {
	test("serves persisted data immediately while coalescing forced refreshes", async () => {
		const path = cachePath();
		const first = new ModelCatalogCache(url, path, parse);
		await first.refresh("public", { fetchFn: vi.fn(async () => response(["old"])) });
		const cache = new ModelCatalogCache(url, path, parse);
		let finish!: (value: Response) => void;
		const fetchFn = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		expect(cache.get("public")).toEqual(["old"]);
		const pending = cache.refresh("public", { force: true, fetchFn });
		expect(cache.refresh("public", { force: true, fetchFn })).toBe(pending);
		expect(cache.get("public")).toEqual(["old"]);
		finish(response(["old", "new"]));
		expect(await pending).toEqual(["old", "new"]);
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(new ModelCatalogCache(url, path, parse).get("public")).toEqual(["old", "new"]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("revalidates with ETags and refreshes after six hours", async () => {
		vi.useFakeTimers();
		const cache = new ModelCatalogCache(url, cachePath(), parse);
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(["model"], '"v1"'))
			.mockResolvedValueOnce(new Response(null, { status: 304 }));
		await cache.refresh("public", { fetchFn });
		await cache.refresh("public", { fetchFn });
		expect(fetchFn).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(MODEL_CATALOG_REFRESH_INTERVAL_MS);
		expect(await cache.refresh("public", { fetchFn })).toEqual(["model"]);
		expect(new Headers(fetchFn.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"v1"');
	});

	test("keeps last-good data on invalid JSON, invalid metadata, network errors, and oversized responses", async () => {
		const path = cachePath();
		const cache = new ModelCatalogCache(url, path, parse);
		await cache.refresh("public", { fetchFn: vi.fn(async () => response(["old"])) });
		const disk = readFileSync(path, "utf8");
		for (const invalid of [
			new Response("{"),
			new Response("{}"),
			new Response(null, { status: 503 }),
			new Response("[]", { headers: { "content-length": String(9 * 1024 * 1024) } }),
		]) {
			expect(await cache.refresh("public", { force: true, fetchFn: vi.fn(async () => invalid) })).toEqual(["old"]);
			expect(readFileSync(path, "utf8")).toBe(disk);
		}
		const fetchFn = vi.fn(async () => {
			throw new Error("offline");
		});
		expect(await cache.refresh("public", { force: true, fetchFn })).toEqual(["old"]);
		vi.stubEnv("PI_OFFLINE", "1");
		fetchFn.mockClear();
		expect(await cache.refresh("public", { force: true, fetchFn })).toEqual(["old"]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("never applies or persists a response from an old account/team", async () => {
		const path = cachePath();
		const cache = new ModelCatalogCache(url, path, parse);
		let finish!: (value: Response) => void;
		const pending = cache.refresh("team-a", {
			fetchFn: vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve;
					}),
			),
		});
		await cache.refresh("team-b", { fetchFn: vi.fn(async () => response(["private-b"])) });
		finish(response(["private-a"]));
		expect(await pending).toBeUndefined();
		expect(cache.get("team-b")).toEqual(["private-b"]);
		expect(new ModelCatalogCache(url, path, parse).get("team-a")).toBeUndefined();
		expect(cache.get("public")).toBeUndefined();
		expect(readFileSync(path, "utf8")).not.toContain("private-a");
	});

	test("starts a new refresh when returning to a scope with an obsolete request", async () => {
		const path = cachePath();
		const cache = new ModelCatalogCache(url, path, parse);
		let finish!: (value: Response) => void;
		const obsolete = cache.refresh("team-a", {
			fetchFn: vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve;
					}),
			),
		});
		expect(cache.get("team-b")).toBeUndefined();
		const current = cache.refresh("team-a", { fetchFn: vi.fn(async () => response(["current-a"])) });
		expect(current).not.toBe(obsolete);
		expect(await current).toEqual(["current-a"]);
		finish(response(["obsolete-a"]));
		expect(await obsolete).toBeUndefined();
		expect(cache.get("team-a")).toEqual(["current-a"]);
		expect(new ModelCatalogCache(url, path, parse).get("team-a")).toEqual(["current-a"]);
	});

	test("clears denied private access instead of serving stale authorization", async () => {
		const path = cachePath();
		const cache = new ModelCatalogCache(url, path, parse);
		await cache.refresh("team", { fetchFn: vi.fn(async () => response(["private"])) });
		expect(
			await cache.refresh("team", { force: true, fetchFn: vi.fn(async () => new Response(null, { status: 403 })) }),
		).toBeUndefined();
		expect(cache.get("team")).toBeUndefined();
		expect(new ModelCatalogCache(url, path, parse).get("team")).toBeUndefined();
	});
});
