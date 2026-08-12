import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getOpenRouterModels, resetOpenRouterModelCache } from "../src/core/openrouter-model-catalog.js";

const model: Model<Api> = {
	id: "vendor/live-new",
	name: "Live New",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4000,
	maxTokens: 1000,
};

const okResponse = (id = "vendor/live-new"): Partial<Response> => ({
	ok: true,
	status: 200,
	json: async () => ({
		data: [
			{
				id,
				name: "Live New",
				supported_parameters: ["tools"],
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: {},
				top_provider: { max_completion_tokens: 1000 },
				context_length: 4000,
			},
		],
	}),
});

afterEach(() => resetOpenRouterModelCache());

describe("getOpenRouterModels", () => {
	test("returns cached results without a second fetch", async () => {
		const fetchMock = vi.fn(async () => okResponse() as Response);
		const first = await getOpenRouterModels(fetchMock as typeof fetch);
		const second = await getOpenRouterModels(fetchMock as typeof fetch);
		expect(first?.[0].id).toBe("vendor/live-new");
		expect(second?.[0].id).toBe("vendor/live-new");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("deduplicates concurrent callers", async () => {
		let resolveGate: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		const fetchMock = vi.fn(async () => {
			await gate;
			return okResponse() as Response;
		});
		const p1 = getOpenRouterModels(fetchMock as typeof fetch);
		const p2 = getOpenRouterModels(fetchMock as typeof fetch);
		resolveGate?.();
		const [a, b] = await Promise.all([p1, p2]);
		expect(a?.[0].id).toBe("vendor/live-new");
		expect(b?.[0].id).toBe("vendor/live-new");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("returns undefined on a cold failure", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toBeUndefined();
	});

	test("returns last-known-good on a later failure and backs off", async () => {
		vi.useFakeTimers();
		const start = Date.now();
		const fetchMock = vi
			.fn(async () => okResponse() as Response)
			.mockResolvedValueOnce(okResponse() as Response)
			.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
		await getOpenRouterModels(fetchMock as typeof fetch);
		vi.setSystemTime(start + 5 * 60_000 + 1);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toEqual([model]);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toEqual([model]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	test("returns undefined on a malformed payload", async () => {
		const fetchMock = vi.fn(async () => ({ ...okResponse(), json: async () => ({ not: "data" }) }) as Response);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toBeUndefined();
	});

	test("treats a zero-valid-model payload as a failure", async () => {
		const fetchMock = vi.fn(async () => ({ ...okResponse(), json: async () => ({ data: [{}] }) }) as Response);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toBeUndefined();
	});

	test("refetches when requireId is missing from a fresh cache", async () => {
		vi.useFakeTimers();
		const start = Date.now();
		const fetchMock = vi
			.fn(async () => okResponse() as Response)
			.mockResolvedValueOnce(okResponse() as Response)
			.mockResolvedValueOnce(okResponse("vendor/later") as Response);
		await getOpenRouterModels(fetchMock as typeof fetch);
		vi.setSystemTime(start + 60_000);
		expect((await getOpenRouterModels(fetchMock as typeof fetch, "vendor/later"))?.[0].id).toBe("vendor/later");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	test("retries a cold failure when requireId is missing", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
			.mockResolvedValueOnce(okResponse() as Response);
		expect(await getOpenRouterModels(fetchMock as typeof fetch)).toBeUndefined();
		expect(await getOpenRouterModels(fetchMock as typeof fetch, "vendor/live-new")).toEqual([model]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
