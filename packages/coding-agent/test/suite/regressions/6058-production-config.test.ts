import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getPrimeAgentTraceCredential } from "../../../src/core/agent-traces.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import {
	loginPrimeAgentTraces,
	loginPrimeInference,
	resolvePrimeInferenceAuthConfig,
} from "../../../src/core/prime-inference-auth.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-6058 production identity isolation", () => {
	let harness: Harness;
	beforeEach(async () => {
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		vi.stubEnv("PRIME_AGENT_TRACES_API_KEY", "");
		vi.stubEnv("PRIME_AGENT_TRACES_BASE_URL", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "");
		harness = await createHarness();
	});
	afterEach(() => {
		harness.cleanup();
		vi.unstubAllEnvs();
	});

	test.each([
		{ base_url: "https://dev-api.example/api/v1" },
		{ frontend_url: "https://dev-app.example" },
		{ inference_url: "https://dev-inference.example/api/v1" },
		{ base_url: null },
		{ frontend_url: "" },
		{ inference_url: 123 },
	])("never sends an ineligible CLI key during login: %j", async (urls) => {
		const configPath = join(harness.tempDir, "config.json");
		const original = JSON.stringify({ api_key: "development-secret", team_id: "dev-team", ...urls });
		writeFileSync(configPath, original);
		for (const login of [loginPrimeInference, loginPrimeAgentTraces]) {
			const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
				expect(String(url)).toBe("https://api.primeintellect.ai/api/v1/auth_challenge/generate");
				expect(JSON.stringify(init)).not.toContain("development-secret");
				throw new Error("stop before browser");
			});
			await expect(login({ onAuth: vi.fn() }, { configPath, fetchFn })).rejects.toThrow("stop before browser");
			expect(fetchFn).toHaveBeenCalledOnce();
		}
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	test.each([
		["PRIME_AGENT_INFERENCE_API_BASE_URL", "https://agent-api.example/api/v1/", "https://agent-api.example"],
		["PRIME_AGENT_INFERENCE_FRONTEND_URL", "https://agent-app.example/", "https://api.primeintellect.ai"],
	])("honors %s without importing CLI credentials into a custom auth target", async (name, value, baseUrl) => {
		vi.stubEnv(name, value);
		const configPath = join(harness.tempDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ api_key: "production-key" }));
		const config = resolvePrimeInferenceAuthConfig();
		expect(config.baseUrl).toBe(baseUrl);
		expect(config.frontendUrl).toBe(
			name.endsWith("FRONTEND_URL") ? "https://agent-app.example" : "https://app.primeintellect.ai",
		);
		const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
			expect(String(url)).toBe(`${baseUrl}/api/v1/auth_challenge/generate`);
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			throw new Error("stop before browser");
		});
		await expect(loginPrimeInference({ onAuth: vi.fn() }, { configPath, fetchFn })).rejects.toThrow(
			"stop before browser",
		);
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	test("defaults blank overrides to production and ignores unrelated endpoint variables", () => {
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "  ");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "  ");
		vi.stubEnv("PRIME_API_BASE_URL", "https://unrelated.example");
		vi.stubEnv("PRIME_AGENT_TRACES_BASE_URL", "https://traces.example");
		expect(resolvePrimeInferenceAuthConfig()).toEqual({
			baseUrl: "https://api.primeintellect.ai",
			frontendUrl: "https://app.primeintellect.ai",
		});
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", " https://agent-api.example/api/v1/ ");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", " https://agent-app.example/ ");
		expect(resolvePrimeInferenceAuthConfig()).toEqual({
			baseUrl: "https://agent-api.example",
			frontendUrl: "https://agent-app.example",
		});
	});

	test.each(["[]", "[1]", "null", '""', '"fake-secret"', "0", "1", "true", "false", "{", "   "])(
		"rejects non-record or malformed Agent auth at startup without changing it: %s",
		(content) => {
			const authPath = join(harness.tempDir, "invalid-auth.json");
			writeFileSync(authPath, content);
			const auth = AuthStorage.create(authPath);
			expect(auth.drainErrors()).toHaveLength(1);
			expect(auth.list()).toEqual([]);
			const changes = [
				() => auth.setPrimeInferenceApiKey("replacement"),
				() => auth.setPrimeInferenceTeamSelection({ teamId: "team", name: "Team" }),
				() => auth.logout("prime-inference"),
			];
			for (const change of changes) {
				expect(change).toThrow();
				expect(readFileSync(authPath, "utf8")).toBe(content);
				expect(auth.list()).toEqual([]);
			}
			if (content === '"fake-secret"') {
				expect(auth.drainErrors().map((error) => error.message)).toEqual([
					"Invalid auth storage: expected a JSON object",
					"Invalid auth storage: expected a JSON object",
				]);
			}
		},
	);

	test.each(["[]", "[1]", "null", '""', '"fake-secret"', "0", "1", "true", "false", "{", "   "])(
		"rejects current invalid disk data, retains stale identity, and permits repaired-file retry: %s",
		(content) => {
			const authPath = join(harness.tempDir, "changed-auth.json");
			const auth = AuthStorage.create(authPath);
			auth.setPrimeInferenceApiKey("old-key", { teamId: "old-team", name: "Old" });
			const original = auth.get("prime-inference");
			expect(auth.markAuthStale("prime-inference")).toBe(true);
			writeFileSync(authPath, content);
			const changes = [
				() => auth.setPrimeInferenceApiKey("replacement"),
				() => auth.setPrimeInferenceTeamSelection(null, "old-key"),
				() => auth.logout("prime-inference"),
			];
			for (const change of changes) {
				expect(change).toThrow();
				expect(readFileSync(authPath, "utf8")).toBe(content);
				expect(auth.get("prime-inference")).toEqual(original);
				expect(auth.getAuthStatus("prime-inference").source).toBe("stale");
			}
			auth.reload();
			expect(auth.get("prime-inference")).toEqual(original);
			expect(auth.getAuthStatus("prime-inference").source).toBe("stale");
			expect(auth.drainErrors()).toHaveLength(3);
			writeFileSync(authPath, "{}");
			auth.setPrimeInferenceApiKey("repaired-key");
			expect(auth.getAuthStatus("prime-inference")).toEqual({ configured: true, source: "stored" });
			expect(AuthStorage.create(authPath).get("prime-inference")).toEqual({
				type: "api_key",
				key: "repaired-key",
				primeTeam: null,
			});
		},
	);

	test.each(["{}", '{"constructor":null,"__proto__":{"preserved":true},"unknown-provider":{"future":true}}'])(
		"preserves valid JSON object records without prototype-shape assumptions: %s",
		(content) => {
			const authPath = join(harness.tempDir, "object-auth.json");
			writeFileSync(authPath, content);
			const auth = AuthStorage.create(authPath);
			expect(auth.drainErrors()).toEqual([]);
			auth.setPrimeInferenceApiKey("object-key");
			expect(AuthStorage.create(authPath).get("prime-inference")).toEqual({
				type: "api_key",
				key: "object-key",
				primeTeam: null,
			});
			auth.setPrimeInferenceTeamSelection({ teamId: "team", name: "Team" }, "object-key");
			auth.logout("prime-inference");
			expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual(JSON.parse(content));
		},
	);

	test("snapshots a validated production key and file team only on explicit login", async () => {
		const configPath = join(harness.tempDir, "config.json");
		const authPath = join(harness.tempDir, "auth.json");
		const original = JSON.stringify({
			api_key: "production-key",
			team_id: "file-team",
			team_name: "Production",
			base_url: "https://api.primeintellect.ai/api/v1/",
			frontend_url: "https://app.primeintellect.ai/",
			inference_url: "https://api.pinference.ai/api/v1/",
		});
		writeFileSync(configPath, original);
		const auth = AuthStorage.create(authPath, { primeCliConfigPath: configPath });
		await expect(auth.getApiKey("prime-inference")).resolves.toBeUndefined();
		expect(auth.hasAuth("prime-inference")).toBe(false);
		vi.stubEnv("PRIME_TEAM_ID", "env-team");
		const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
			expect(String(url)).toBe("https://api.primeintellect.ai/api/v1/user/whoami");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer production-key");
			return new Response(JSON.stringify({ data: { scope: { inference: { write: true } } } }));
		});
		const result = await loginPrimeInference({ onAuth: vi.fn() }, { configPath, fetchFn });
		auth.setPrimeInferenceApiKey(result.apiKey, result.primeTeam);
		expect(auth.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
		expect(JSON.parse(readFileSync(authPath, "utf8"))["prime-inference"]).toEqual({
			type: "api_key",
			key: "production-key",
			primeTeam: { teamId: "file-team", name: "Production" },
		});
		expect(readFileSync(configPath, "utf8")).toBe(original);
		vi.stubEnv("PRIME_TEAM_ID", "");
		writeFileSync(
			configPath,
			JSON.stringify({ api_key: "dev-key", team_id: "dev-team", base_url: "https://dev-api.example" }),
		);
		const restarted = AuthStorage.create(authPath, { primeCliConfigPath: configPath });
		await expect(restarted.getApiKey("prime-inference")).resolves.toBe("production-key");
		expect(restarted.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "file-team" });
		await expect(getPrimeAgentTraceCredential(restarted)).resolves.toMatchObject({
			apiKey: "production-key",
		});
		restarted.logout("prime-inference");
		const loggedOut = AuthStorage.create(authPath, { primeCliConfigPath: configPath });
		await expect(loggedOut.getApiKey("prime-inference")).resolves.toBeUndefined();
		await expect(getPrimeAgentTraceCredential(loggedOut)).resolves.toBeUndefined();
		expect(JSON.parse(readFileSync(configPath, "utf8")).api_key).toBe("dev-key");
	});
});
