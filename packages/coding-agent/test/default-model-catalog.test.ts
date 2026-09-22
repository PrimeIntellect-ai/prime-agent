import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";

const cacheRoots: string[] = [];

function model(provider: string, id: string): Model<Api> {
	const base = getModels("openai")[0]!;
	return { ...base, provider, id, name: `${provider}/${id}` } as unknown as Model<Api>;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const dir of cacheRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("catalog-defined default model", () => {
	test("prefers the catalog default over the compiled constants", async () => {
		const root = mkdtempSync(join(tmpdir(), "default-model-catalog-"));
		cacheRoots.push(root);
		const agentDir = join(root, "agent");
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("defaults.v1.json")) {
					return new Response(JSON.stringify({ schemaVersion: 1, defaultModel: "anthropic/claude-fable-5" }));
				}
				throw new Error(`unexpected fetch ${url}`);
			}),
		);

		const { refreshDefaultModelCatalog } = await import("../src/core/default-model-catalog.js");
		await refreshDefaultModelCatalog(true);

		const { getPreferredDefaultModelId, resolvePreferredDefaultModel } = await import(
			"../src/core/default-model-catalog.js"
		);
		expect(getPreferredDefaultModelId()).toBe("anthropic/claude-fable-5");
		const resolved = resolvePreferredDefaultModel(getPreferredDefaultModelId(), [
			model("anthropic", "claude-fable-5"),
			model("openai", "gpt-4"),
		]);
		expect(resolved?.provider).toBe("anthropic");
		expect(resolved?.id).toBe("claude-fable-5");
	});

	test("falls back to undefined offline; resolver ignores unknown selectors", async () => {
		const { resolvePreferredDefaultModel } = await import("../src/core/default-model-catalog.js");
		expect(resolvePreferredDefaultModel(undefined, [])).toBeUndefined();
		expect(resolvePreferredDefaultModel("anthropic/gpt-4", [model("openai", "gpt-4")])).toBeUndefined();
	});
});
