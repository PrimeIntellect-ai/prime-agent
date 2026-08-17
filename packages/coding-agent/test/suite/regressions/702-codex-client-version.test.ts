import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";

function codexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #702 codex model discovery client version", () => {
	const tempDirs: string[] = [];
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("reports a Codex CLI client version on the discovery request instead of the package version", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codex-client-version-"));
		tempDirs.push(tempDir);
		const authPath = join(tempDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: codexAccessToken("account-123"),
					refresh: "refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
					accountId: "account-123",
				},
			}),
		);

		const registry = ModelRegistry.create(AuthStorage.create(authPath), join(tempDir, "models.json"));
		const codexModels = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		expect(codexModels.length).toBeGreaterThan(0);

		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
			requestedUrls.push(input instanceof Request ? input.url : input.toString());
			return new Response(JSON.stringify({ models: codexModels.map((model) => ({ slug: model.id })) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		const executable = await registry.getExecutableModels();

		const discoveryUrl = requestedUrls.find((url) => url.includes("/codex/models"));
		expect(discoveryUrl).toBeDefined();
		const clientVersion = new URL(discoveryUrl ?? "").searchParams.get("client_version");
		// Prime Agent's own version is 0.x well below this floor, so this assertion fails on the
		// unfixed source. Comparing against VERSION directly would pass today and break silently
		// once the lockstep package version reaches the pinned constant.
		expect(clientVersion).toMatch(/^\d+\.\d+\.\d+$/);
		const [major, minor] = (clientVersion ?? "0.0.0").split(".").map(Number);
		expect((major ?? 0) > 0 || (minor ?? 0) >= 144).toBe(true);

		expect(executable.some((model) => model.provider === "openai-codex")).toBe(true);
	});
});
