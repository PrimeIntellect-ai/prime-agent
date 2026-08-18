import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AuthStatus, AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";
import { isApiKeyLoginProvider } from "../src/modes/interactive/auth-flows.js";
import {
	compareAuthSelectorProviders,
	OAuthSelectorComponent,
} from "../src/modes/interactive/components/oauth-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		if (originalOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		}
	});

	it("keeps built-in API key providers separate from OAuth-only providers", () => {
		const oauthProviderIds = new Set(["anthropic", "github-copilot", "custom-oauth"]);
		const builtInProviderIds = new Set(["anthropic", "github-copilot", "amazon-bedrock", "openai"]);

		expect(isApiKeyLoginProvider("anthropic", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.anthropic).toBe("Anthropic");
		expect(isApiKeyLoginProvider("openai", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("github-copilot", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("amazon-bedrock", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("custom-oauth", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("custom-api", oauthProviderIds, builtInProviderIds)).toBe(true);
	});

	it("sorts subscription providers before API key providers", () => {
		const providers = [
			{ id: "openai", name: "OpenAI", authType: "api_key" as const },
			{ id: "anthropic", name: "Anthropic", authType: "api_key" as const },
			{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" as const },
			{ id: "anthropic", name: "Anthropic", authType: "oauth" as const },
		].sort(compareAuthSelectorProviders);

		expect(providers.map((provider) => `${provider.authType}:${provider.name}`)).toEqual([
			"oauth:Anthropic",
			"oauth:GitHub Copilot",
			"api_key:Anthropic",
			"api_key:OpenAI",
		]);
	});

	it("sorts Prime Inference first within every login auth-state group", () => {
		const cases: Array<{ status: AuthStatus; configuredProviderLeads: boolean }> = [
			{ status: { configured: true, source: "environment" }, configuredProviderLeads: false },
			{ status: { configured: false, source: "stale", label: "expired" }, configuredProviderLeads: true },
			{ status: { configured: false }, configuredProviderLeads: true },
		];

		for (const { status, configuredProviderLeads } of cases) {
			const selector = new OAuthSelectorComponent(
				"login",
				AuthStorage.inMemory(),
				[
					{ id: "anthropic", name: "Anthropic", authType: "api_key" },
					{ id: PRIME_INFERENCE_PROVIDER_ID, name: "Prime Inference", authType: "api_key" },
					{ id: "openai", name: "OpenAI", authType: "api_key" },
				],
				() => {},
				() => {},
				(providerId) =>
					providerId === "openai" ? { configured: true, source: "environment", label: "OPENAI_API_KEY" } : status,
			);

			const output = stripAnsi(selector.render(120).join("\n"));
			const primeIndex = output.indexOf("Prime Inference");
			const anthropicIndex = output.indexOf("Anthropic");
			const openAiIndex = output.indexOf("OpenAI");

			expect(primeIndex).toBeLessThan(anthropicIndex);
			if (configuredProviderLeads) {
				expect(openAiIndex).toBeLessThan(primeIndex);
			} else {
				expect(primeIndex).toBeLessThan(openAiIndex);
			}
		}
	});

	it("preserves auth type when selecting duplicate provider ids", () => {
		const authStorage = AuthStorage.inMemory();
		const selections: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "anthropic", name: "Anthropic", authType: "api_key" },
			],
			(provider) => {
				selections.push(`${provider.id}:${provider.authType}`);
			},
			() => {},
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(selections).toEqual(["anthropic:api_key"]);
	});

	it("shows configured providers before unconfigured providers", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output.indexOf("OpenAI")).toBeLessThan(output.indexOf("Anthropic"));
		expect(output.indexOf("OpenAI")).toBeLessThan(output.indexOf("GitHub Copilot"));
	});

	it("shows stored OAuth auth distinctly in the API key selector", () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("OpenAI");
		expect(output).toContain("env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows stale auth as expired instead of configured", () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "stale-access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		authStorage.markAuthStale("anthropic");
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "anthropic", name: "Anthropic", authType: "oauth" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("expired");
		expect(output).not.toContain("configured");
	});

	it("does not sort stale auth ahead of configured providers", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "stale-access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		authStorage.markAuthStale("anthropic");
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output.indexOf("OpenAI")).toBeLessThan(output.indexOf("Anthropic"));
		expect(output).toContain("expired");
	});

	it("sorts stale auth ahead of unconfigured providers", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory({
			"prime-inference": {
				type: "api_key",
				key: "stale-prime-key",
			},
		});
		authStorage.markAuthStale("prime-inference");
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[
				{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" },
				{ id: "amazon-bedrock", name: "Amazon Bedrock", authType: "api_key" },
				{ id: "prime-inference", name: "Prime Inference", authType: "api_key" },
				{ id: "openai", name: "OpenAI", authType: "api_key" },
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output.indexOf("OpenAI")).toBeLessThan(output.indexOf("Prime Inference"));
		expect(output.indexOf("Prime Inference")).toBeLessThan(output.indexOf("GitHub Copilot"));
		expect(output.indexOf("Prime Inference")).toBeLessThan(output.indexOf("Amazon Bedrock"));
		expect(output).toContain("expired");
	});

	it("shows models.json auth instead of stale stored auth on API key rows", () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "stale-access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		authStorage.markAuthStale("anthropic");
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_key" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("key in models.json");
		expect(output).not.toContain("subscription configured");
		expect(output).not.toContain("expired");
	});

	it("shows stale stored auth as expired when models.json auth is active for the provider", () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "stale-access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		authStorage.markAuthStale("anthropic");
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "anthropic", name: "Anthropic", authType: "oauth" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_key" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("expired");
		expect(output).not.toContain("configured");
	});

	it("shows custom provider environment API key auth from status resolver", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "ollama", name: "ollama", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "environment", label: "OLLAMA_API_KEY" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("ollama");
		expect(output).toContain("env: OLLAMA_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "local-proxy", name: "local-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_key" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("local-proxy");
		expect(output).toContain("key in models.json");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json command auth as configured", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "op-proxy", name: "op-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_command" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("op-proxy");
		expect(output).toContain("command in models.json");
		expect(output).not.toContain("unconfigured");
	});

	it("keeps the provider menu within a short terminal viewport", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			Array.from({ length: 12 }, (_, index) => ({
				id: `provider-${index + 1}`,
				name: `Provider ${index + 1}`,
				authType: "api_key" as const,
			})),
			() => {},
			() => {},
			() => ({ configured: false }),
			{ getRows: () => 12 },
		);

		expect(selector.render(80)).toHaveLength(12);

		for (let i = 0; i < 5; i++) {
			selector.handleInput("\x1b[B");
		}
		const output = stripAnsi(selector.render(80).join("\n"));

		expect(selector.render(80)).toHaveLength(12);
		expect(output).toContain("Provider 3");
		expect(output).toContain("(6/12)");
	});

	it("shows Providers/MCP Connections tabs and switches with left/right arrows", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth", category: "provider" },
				{ id: "serper", name: "Serper (web search)", authType: "api_key", category: "service" },
			],
			() => {},
			() => {},
		);

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Providers");
		expect(output).toContain("MCP Connections");
		expect(output).toContain("Anthropic");
		expect(output).not.toContain("Serper");

		selector.handleInput("\x1b[C");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
	});

	it("selecting on the MCP Connections tab returns the service entry", () => {
		let chosen: string | undefined;
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth", category: "provider" },
				{ id: "serper", name: "Serper (web search)", authType: "api_key", category: "service" },
			],
			(provider) => {
				chosen = provider.id;
			},
			() => {},
		);

		selector.handleInput("\x1b[C"); // -> MCP Connections tab
		selector.handleInput("\r"); // confirm
		expect(chosen).toBe("serper");
	});

	it("can open with the MCP Connections tab active", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[
				{ id: "anthropic", name: "Anthropic", authType: "oauth", category: "provider" },
				{ id: "serper", name: "Serper (web search)", authType: "api_key", category: "service" },
			],
			() => {},
			() => {},
			undefined,
			{ initialCategory: "service" },
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
	});

	it("falls back when the requested initial category is unavailable", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[{ id: "anthropic", name: "Anthropic", authType: "oauth", category: "provider" }],
			() => {},
			() => {},
			undefined,
			{ initialCategory: "service" },
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Anthropic");
	});

	it("shows no tab bar when only one category is present", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			[{ id: "anthropic", name: "Anthropic", authType: "oauth", category: "provider" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).not.toContain("←/→ switch");
	});
});
