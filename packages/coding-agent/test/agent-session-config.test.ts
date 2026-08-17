import { describe, expect, it } from "vitest";
import {
	type AgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
	sanitizeAgentSessionRuntimeConfigForDurableStorage,
} from "../src/core/agent-session-config.js";

describe("mergeAgentSessionRuntimeConfig", () => {
	it("applies session overrides without mutating default config", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			extensionFlagValues: { plan: true },
		};

		const overrides: AgentSessionRuntimeConfig = {
			cwd: "/repo/session",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			extensionFlagValues: { mode: "fast" },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged).toEqual({
			cwd: "/repo/session",
			agentDir: "/agent/default",
			model: "anthropic/claude-sonnet-4-5",
			tools: ["bash"],
			noTools: false,
			extensionFlagValues: { plan: true, mode: "fast" },
		});
		expect(merged.tools).not.toBe(overrides.tools);
		expect(merged.extensionFlagValues).not.toBe(defaults.extensionFlagValues);
		expect(defaults).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: true,
			extensionFlagValues: { plan: true },
		});
	});

	it("keeps default arrays when a session override omits them", () => {
		const defaults: AgentSessionRuntimeConfig = {
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, { model: "openai/gpt-4o-mini" });
		expect(merged).toEqual({
			appendSystemPrompt: ["default prompt"],
			models: ["openai/gpt-4o"],
			extensions: ["/agent/ext.js"],
			skills: ["/agent/skill.md"],
			promptTemplates: ["/agent/template.md"],
			themes: ["/agent/theme.json"],
			model: "openai/gpt-4o-mini",
		});
		expect(merged.models).not.toBe(defaults.models);
		expect(merged.extensions).not.toBe(defaults.extensions);
	});

	it("deep-merges autonomous gate overrides", () => {
		const defaults: AgentSessionRuntimeConfig = {
			autonomous: {
				enabled: true,
				maxTurns: 20,
				gates: { commands: ["npm test"], maxRetries: 3 },
			},
		};

		const overrides: AgentSessionRuntimeConfig = {
			autonomous: {
				maxContinuations: 5,
				gates: { timeoutMs: 1000 },
			},
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, overrides);

		expect(merged.autonomous).toEqual({
			enabled: true,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
		expect(merged.autonomous?.gates?.commands).not.toBe(defaults.autonomous?.gates?.commands);
	});

	it("ignores undefined override values", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
		};

		const merged = mergeAgentSessionRuntimeConfig(defaults, {
			cwd: undefined,
			model: undefined,
			tools: undefined,
			noTools: false,
		});

		expect(merged).toEqual({
			cwd: "/repo/default",
			agentDir: "/agent/default",
			model: "openai/gpt-4o",
			tools: ["ipython"],
			noTools: false,
		});
	});

	it("merges initialGoal from override over base", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, {
			cwd: "/override",
			initialGoal: { objective: "override goal" },
		});
		expect(merged.initialGoal).toEqual({ objective: "override goal" });
	});

	it("preserves base initialGoal when override omits it", () => {
		const defaults: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(defaults, { model: "openai/gpt-4o" });
		expect(merged.initialGoal).toEqual({ objective: "base goal", tokenBudget: 50000 });
	});

	it("clones initialGoal so mutating the original does not affect the merged config", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			agentDir: "/agent",
			initialGoal: { objective: "base goal", tokenBudget: 50000 },
		};
		const merged = mergeAgentSessionRuntimeConfig(base);
		expect(merged.initialGoal).toEqual({ objective: "base goal", tokenBudget: 50000 });
		// Mutating the original should not affect the clone
		base.initialGoal!.objective = "mutated";
		expect(merged.initialGoal?.objective).toBe("base goal");
	});

	it("preserves and overrides the user-facing execution mode across daemon config merges", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/repo",
			executionMode: "interactive",
		};

		expect(mergeAgentSessionRuntimeConfig(base, { model: "openai/gpt-4o" }).executionMode).toBe("interactive");
		expect(mergeAgentSessionRuntimeConfig(base, { executionMode: "rpc" }).executionMode).toBe("rpc");
		expect(mergeAgentSessionRuntimeConfig(base).executionMode).toBe("interactive");
	});

	it("keeps the daemon telemetry opt-out monotonic across config merges", () => {
		expect(mergeAgentSessionRuntimeConfig({ telemetryDisabled: true }, {}).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, { telemetryDisabled: true }).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, {}).telemetryDisabled).toBeUndefined();
	});
	describe("sanitizeAgentSessionRuntimeConfigForDurableStorage", () => {
		it("removes recursive credential aliases and header containers while preserving product config", () => {
			const shared = {
				AWS_ACCESS_KEY_ID: "LEAK_ME_AWS_ID_SNAKE",
				AWS_SECRET_ACCESS_KEY: "LEAK_ME_AWS_SNAKE",
				"aws-secret-access-key": "LEAK_ME_AWS_KEBAB",
				productKeyId: "catalog-key",
			};
			const runtimeConfig = {
				cwd: "/repo",
				apiKey: "LEAK_ME_TOP",
				initialGoal: { objective: "keep the configured budget", tokenBudget: 1234 },
				extensionFlagValues: {
					provider: {
						providerApiKey: "LEAK_ME_PROVIDER",
						openaiApiKey: "LEAK_ME_OPENAI",
						refresh: "LEAK_ME_REFRESH",
						OAuth_REFRESH: "LEAK_ME_OAUTH_REFRESH_SNAKE",
						"oauth-access": "LEAK_ME_OAUTH_ACCESS_KEBAB",
						OAUTH_EXPIRES: "LEAK_ME_OAUTH_EXPIRES_CASE",
						ProviderToken: "LEAK_ME_PROVIDER_TOKEN_CASE",
						apiSecret: "LEAK_ME_API_SECRET",
						"secret-key": "LEAK_ME_SECRET_KEY_KEBAB",
						auth: "LEAK_ME_AUTH",
						access: "LEAK_ME_ACCESS",
						expires: 123456,
						expiresAt: 123457,
						product: "bedrock",
						networkAccess: "private",
						productAccess: "enabled",
						productKeyId: "product-key",
						tokenLimit: 5678,
						aws: {
							accessKeyId: "LEAK_ME_AWS_ID",
							secretAccessKey: "LEAK_ME_AWS_SECRET",
							awsSecretAccessKey: "LEAK_ME_AWS_CAMEL",
							sessions: [{ sessionToken: "LEAK_ME_SESSION", region: "us-east-1" }],
						},
						headers: { safe: "LEAK_ME_HEADER" },
						requestHeaders: { safe: "LEAK_ME_REQUEST_HEADER" },
						httpHeaders: { safe: "LEAK_ME_HTTP_HEADER" },
						extraHeaders: { safe: "LEAK_ME_EXTRA_HEADER" },
						defaultHeaders: { safe: "LEAK_ME_DEFAULT_HEADER" },
						first: shared,
						second: shared,
					},
				},
			} as unknown as AgentSessionRuntimeConfig;

			const durable = sanitizeAgentSessionRuntimeConfigForDurableStorage(runtimeConfig);

			expect(durable).toEqual({
				cwd: "/repo",
				initialGoal: { objective: "keep the configured budget", tokenBudget: 1234 },
				extensionFlagValues: {
					provider: {
						product: "bedrock",
						networkAccess: "private",
						productAccess: "enabled",
						productKeyId: "product-key",
						tokenLimit: 5678,
						aws: { sessions: [{ region: "us-east-1" }] },
						first: { productKeyId: "catalog-key" },
						second: { productKeyId: "catalog-key" },
					},
				},
			});
			const provider = durable.extensionFlagValues?.provider as unknown as Record<string, unknown>;
			expect(provider.first).toBe(provider.second);
			expect(runtimeConfig.apiKey).toBe("LEAK_ME_TOP");
			const liveProvider = runtimeConfig.extensionFlagValues?.provider as unknown as Record<string, unknown>;
			expect(liveProvider["secret-key"]).toBe("LEAK_ME_SECRET_KEY_KEBAB");
			expect(liveProvider.auth).toBe("LEAK_ME_AUTH");
			expect((runtimeConfig.extensionFlagValues?.provider as { first?: unknown }).first).toBe(shared);
		});

		it("redacts recursive aliases in cyclic config without mutating the source", () => {
			const cyclic: Record<string, unknown> = {
				product: "safe",
				authorizationHeader: "LEAK_ME_AUTH",
				"X-API-Key": "LEAK_ME_X_API",
			};
			cyclic.self = cyclic;
			const runtimeConfig = { extensionFlagValues: { cyclic } } as unknown as AgentSessionRuntimeConfig;

			const durable = sanitizeAgentSessionRuntimeConfigForDurableStorage(runtimeConfig);
			const sanitized = durable.extensionFlagValues?.cyclic as unknown as Record<string, unknown>;

			expect(sanitized.product).toBe("safe");
			expect(sanitized.authorizationHeader).toBeUndefined();
			expect(sanitized["X-API-Key"]).toBeUndefined();
			expect(sanitized.self).toBe(sanitized);
			expect(cyclic.authorizationHeader).toBe("LEAK_ME_AUTH");
			expect(cyclic.self).toBe(cyclic);
		});
	});
});
