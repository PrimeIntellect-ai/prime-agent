// ENG-6108 OAuth client identity wiring. The five provider registration sites
// must resolve the SAME identity (settings fields -> engine options) at login
// and refresh time; the engine pins client identity on stored credentials and
// refuses drift, so a mismatched factory breaks refresh spuriously.
// Offline: temporary files, denied fetch, synthetic credentials, no OAuth flow.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { createConfiguredMcpProvider, resolveMcpOAuthIdentity } from "../src/core/mcp/service-catalog.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const createProviderMock = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-ai/mcp", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/mcp")>();
	return {
		...actual,
		createMcpOAuthProvider: ((config: unknown) => {
			createProviderMock(config);
			// The real provider keeps every downstream behavior intact.
			return actual.createMcpOAuthProvider(config as never);
		}) as typeof actual.createMcpOAuthProvider,
	};
});

const IDENTITY_CONFIG: McpServerConfig = {
	type: "http",
	url: "https://mcp.acme.test/mcp",
	oauth: true,
	oauthClientId: "my-client",
	oauthClientSecretEnvVar: "ACME_IDENTITY_SECRET",
	oauthClientMetadataUrl: "https://mcp.acme.test/.well-known/client-metadata",
	oauthScopes: ["read", "write"],
};

describe("ENG-6108 OAuth client identity wiring", () => {
	let tempDir: string;
	let realFetch: typeof globalThis.fetch;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-identity-"));
		process.env.ACME_IDENTITY_SECRET = "configured-secret";
		createProviderMock.mockClear();
		resetOAuthProviders();
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("unexpected network fetch in offline mcp identity test");
		}) as typeof fetch;
	});

	afterEach(() => {
		delete process.env.ACME_IDENTITY_SECRET;
		globalThis.fetch = realFetch;
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function providerConfigs(): Array<Record<string, unknown>> {
		return createProviderMock.mock.calls.map((call) => call[0] as Record<string, unknown>);
	}

	it("resolves a configured identity with fail-closed secret and joined scopes", () => {
		const identity = resolveMcpOAuthIdentity(IDENTITY_CONFIG);
		expect(identity).toEqual({
			clientId: "my-client",
			clientSecret: "configured-secret",
			clientMetadataUrl: "https://mcp.acme.test/.well-known/client-metadata",
			scopes: ["read", "write"],
		});
	});

	it("factory maps identity onto engine options: settings scopes win, catalog scopes fill otherwise", () => {
		createConfiguredMcpProvider({
			server: "acme",
			label: "Acme",
			url: "https://mcp.acme.test/mcp",
			identity: resolveMcpOAuthIdentity(IDENTITY_CONFIG),
			reviewedScopes: ["catalog-only"],
			clientRegistration: "pre-registered",
		});
		expect(providerConfigs()).toEqual([
			{
				server: "acme",
				label: "Acme",
				url: "https://mcp.acme.test/mcp",
				clientId: "my-client",
				clientSecret: "configured-secret",
				clientMetadataUrl: "https://mcp.acme.test/.well-known/client-metadata",
				scopes: "read write",
				clientRegistration: "pre-registered",
			},
		]);
	});

	it("factory falls back to reviewed catalog scopes when no settings scopes exist", () => {
		createConfiguredMcpProvider({
			server: "acme",
			url: "https://mcp.acme.test/mcp",
			identity: {},
			reviewedScopes: ["catalog-a", "catalog-b"],
		});
		expect(providerConfigs()).toEqual([
			{ server: "acme", url: "https://mcp.acme.test/mcp", scopes: "catalog-a catalog-b" },
		]);
	});

	it("manager refresh registration resolves the settings identity, fail-closed on a missing secret env", async () => {
		delete process.env.ACME_IDENTITY_SECRET;
		new McpManager({
			authStorage: AuthStorage.inMemory(),
			connectionStore: McpConnectionStore.open(join(tempDir, "mcp-connections.json")),
			getUserServers: () => ({ acme: IDENTITY_CONFIG }),
		});
		const configs = providerConfigs().filter((config) => config.server === "acme");
		expect(configs).toEqual([
			{
				server: "acme",
				label: "acme",
				url: "https://mcp.acme.test/mcp",
				clientId: "my-client",
				// Explicit empty string: the engine fails closed before any
				// network request; never a stale stored secret fallback.
				clientSecret: "",
				clientMetadataUrl: "https://mcp.acme.test/.well-known/client-metadata",
				scopes: "read write",
			},
		]);
	});

	it("manager catalog and per-account sites carry catalog advisory data, not user identity", async () => {
		const store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		const now = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			verifiedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		createProviderMock.mockClear();
		new McpManager({
			authStorage: AuthStorage.inMemory(),
			connectionStore: store,
			getServiceCatalog: () => [
				{
					serviceId: "acme",
					label: "Acme",
					aliases: [],
					transport: { type: "http", url: "https://mcp.acme.test/mcp" },
					authStrategy: "oauth",
					setup: { status: "ready" },
					metadataReviewed: true,
					legacyBuiltin: false,
					clientRegistration: "dynamic",
					reviewedScopes: ["catalog-a"],
				},
			],
		});
		const configs = providerConfigs().filter((config) => config.server === "acme" || config.server === "acme-2");
		expect(configs).toEqual([
			{
				server: "acme",
				label: "Acme",
				url: "https://mcp.acme.test/mcp",
				scopes: "catalog-a",
				clientRegistration: "dynamic",
			},
			{
				server: "acme-2",
				label: "Acme (acme-2)",
				url: "https://mcp.acme.test/mcp",
				scopes: "catalog-a",
				clientRegistration: "dynamic",
			},
		]);
	});

	it("a guarded settings login registers staged and real ids with the IDENTICAL identity", async () => {
		const authStorage = AuthStorage.inMemory();
		const store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			createAuthFlows: () => ({
				runMcpLogin: async (serverId: string) => {
					authStorage.set(`mcp:${serverId}`, {
						type: "oauth",
						access: "identity-credential",
						refresh: "r",
						expires: Date.now() + 3600_000,
						endpoint: "https://mcp.acme.test/mcp",
					});
					return { status: "success" };
				},
			}),
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			isAgentStreaming: () => false,
			isAgentCompacting: () => false,
			handleReloadCommand: vi.fn(async () => true),
			settingsManager: {
				getGlobalMcpServers: () => ({ acme: IDENTITY_CONFIG }),
				getMcpCatalogSources: () => [],
			},
			uiServices: { settingsManager: { getGlobalMcpServers: () => ({ acme: IDENTITY_CONFIG }) } },
		} as unknown as Record<string, unknown>;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		await (
			fake as unknown as {
				connectMcpAccountByName: (name: string) => Promise<{ resolved: boolean; result: { status: string } }>;
			}
		).connectMcpAccountByName.call(fake, "acme");

		const staged = providerConfigs().find(
			(config) => typeof config.server === "string" && config.server.includes("--"),
		);
		const real = providerConfigs().find((config) => config.server === "acme");
		expect(staged).toBeDefined();
		expect(real).toBeDefined();
		// The SAME resolved identity lands on the staged login and the real
		// account provider: the engine's refresh binding never sees drift.
		for (const config of [staged, real]) {
			expect(config).toMatchObject({
				url: "https://mcp.acme.test/mcp",
				clientId: "my-client",
				clientSecret: "configured-secret",
				clientMetadataUrl: "https://mcp.acme.test/.well-known/client-metadata",
				scopes: "read write",
			});
		}
	});
});
