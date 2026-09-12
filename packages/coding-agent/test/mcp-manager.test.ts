import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import type { McpServiceDescriptor } from "../src/core/mcp/service-catalog.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.linear.app/mcp",
		});
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).not.toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");

		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerAllProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage, noBackgroundVerification: true });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.config",
			"mcp.list_connections",
			"mcp.list_plugins",
			"mcp.refresh",
			"mcp.search_plugins",
		]);

		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			noBackgroundVerification: true,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.begin_login",
			"mcp.config",
			"mcp.list_connections",
			"mcp.list_plugins",
			"mcp.refresh",
			"mcp.search_plugins",
		]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("mcp.config keeps catalog names reserved from generic overrides and serves connected catalog services", async () => {
		const manager = new McpManager({
			authStorage,
			noBackgroundVerification: true,
			getUserServers: () => ({
				linear: { type: "http", url: "https://proxy.test/mcp", oauth: true, headers: { "X-Extra": "1" } },
			}),
		});
		const handlers = manager.hostHandlers();
		// A user entry shadowing a bundled catalog name is dead by design.
		expect(await handlers["mcp.config"]({ server: "linear" })).toEqual({});
		// An unconnected catalog service is not dispatched through the generic route.
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({});

		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.notion.com/mcp",
		});
		// Stored credentials put the catalog service on the generic route.
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({
			type: "http",
			url: "https://mcp.notion.com/mcp",
			oauth: true,
		});
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.linear.app/mcp",
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp", oauth: true } }),
		});
		expect(manager.listStatus().find((s) => s.server === "linear")?.enabled).toBe(false);
	});

	it("does not enable a server from a credential bound to a different endpoint or unbound", () => {
		authStorage.set("mcp:unbound", {
			type: "oauth",
			access: "unbound-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		authStorage.set("mcp:remote", {
			type: "oauth",
			access: "old-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://old.test/mcp",
		} as never);
		const manager = new McpManager({
			authStorage,
			getServiceCatalog: () => [],
			getUserServers: () => ({
				remote: { type: "http", url: "https://new.test/mcp", oauth: true },
				unbound: { type: "http", url: "https://srv.test/mcp", oauth: true },
			}),
		});
		expect(manager.listStatus().find((s) => s.server === "remote")?.enabled).toBe(false);
		expect(manager.listStatus().find((s) => s.server === "unbound")?.enabled).toBe(false);
		expect(manager.getEnabledPersistentGenericServers()).toEqual([]);
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("lists enabled generic servers including connected catalog services in deterministic order", () => {
		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.notion.com/mcp",
		});
		const manager = new McpManager({
			authStorage,
			noBackgroundVerification: true,
			getServiceCatalog: () => LEGACY_CATALOG,
			getUserServers: () => ({
				zebra: { type: "stdio", command: "z" },
				disabled: { type: "stdio", command: "off", enabled: false },
				linear: { type: "stdio", command: "reserved" },
				alpha: { type: "http", url: "https://alpha.test/mcp" },
			}),
		});

		// The linear shadow stays dead (reserved catalog name); connected notion joins.
		expect(manager.getEnabledPersistentGenericServers()).toEqual(["alpha", "notion", "zebra"]);
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("keeps the built-in provider when a user server uses a reserved catalog name", () => {
		new McpManager({
			authStorage,
			getUserServers: () => ({
				linear: { type: "http", url: "https://proxy.test/mcp", oauth: true },
			}),
		});
		const provider = getOAuthProvider("mcp:linear");
		expect(provider?.name).toBe("Linear");
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});
	it("serves user stdio configuration without resolving tagged environment values", async () => {
		const config: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: ["server.js", "--raw"],
			cwd: "/tmp/work",
			env: { TOKEN: { env: "MCP_TOKEN" } },
			enabledTools: ["raw.tool/name"],
		};
		const manager = new McpManager({ authStorage, getUserServers: () => ({ local: config }) });
		expect(await manager.hostHandlers()["mcp.config"]({ server: "local" })).toEqual(config);
		expect(manager.listStatus().find((status) => status.server === "local")?.enabled).toBe(true);
	});

	it("does not enable an authored catalog skill when a generic server shadows its name", () => {
		for (const config of [
			{ type: "stdio", command: "node" },
			{ type: "http", url: "https://proxy.test/mcp" },
		] satisfies McpServerConfig[]) {
			const manager = new McpManager({ authStorage, getUserServers: () => ({ linear: config }) });
			expect(manager.getDisabledBuiltinSkillOverrides()).toContain("-linear/SKILL.md");
		}
	});
	it("keeps ACP credentials session-scoped and isolated from stored OAuth", async () => {
		authStorage.set("mcp:task", {
			type: "oauth",
			access: "stored-oauth-token",
			refresh: "refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://user.example/mcp",
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ task: { type: "http", url: "https://user.example/mcp", oauth: true } }),
		});
		expect(
			manager.replaceAcpServers(
				[
					{
						name: "task",
						type: "http",
						url: "https://task.example/mcp",
						headers: { Authorization: "Bearer task-token" },
					},
				],
				"owner-a",
			),
		).toBe(true);
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "task" })).toEqual({
			type: "http",
			url: "https://task.example/mcp",
			headers: { Authorization: "Bearer task-token" },
			credentialSource: "acp",
		});
		await expect(handlers["mcp.refresh"]({ server: "task" })).rejects.toThrow("does not use host OAuth");
		expect(manager.getAcpServers().map((server) => server.name)).toContain("task");

		expect(manager.replaceAcpServers([], "owner-b")).toBe(false);
		expect(() =>
			manager.replaceAcpServers(
				[{ name: "other", type: "http", url: "https://other.example/mcp", headers: {} }],
				"owner-b",
			),
		).toThrow("owned by another client");
		expect(await handlers["mcp.config"]({ server: "task" })).toMatchObject({
			url: "https://task.example/mcp",
			credentialSource: "acp",
		});

		expect(manager.replaceAcpServers([], "owner-a")).toBe(true);
		expect(await handlers["mcp.config"]({ server: "task" })).toEqual({
			type: "http",
			url: "https://user.example/mcp",
			oauth: true,
		});
		expect(authStorage.get("mcp:task")).toMatchObject({ access: "stored-oauth-token" });
	});

	it("fails closed with empty auth on the REAL bundled catalog: zero none+ready rows are enabled, aws-devops-agent included", () => {
		const manager = new McpManager({ authStorage });
		// No user servers, empty auth: the enabled generic set is exactly the
		// bundled rows that are explicitly public no-auth AND setup-ready —
		// zero such rows exist today, so api_key/requires-setup rows
		// (aws-devops-agent) must never appear.
		expect(manager.getEnabledPersistentGenericServers()).toEqual([]);
		expect(manager.listStatus().find((s) => s.server === "aws-devops-agent")?.enabled).toBe(false);
	});

	it("never enables a catalog api_key row even when its token env var is set (no field-id inference)", () => {
		process.env.CATALOG_API_KEY_TEST = "some-key";
		try {
			const manager = new McpManager({
				authStorage,
				getServiceCatalog: () => [
					{
						serviceId: "needs-key",
						label: "Needs Key",
						aliases: [],
						transport: { type: "http", url: "https://key.example/mcp" },
						authStrategy: "api_key",
						setup: { status: "requires-setup", reason: "requires an API key" },
						metadataReviewed: true,
						legacyBuiltin: false,
					},
				],
			});
			expect(manager.getEnabledPersistentGenericServers()).toEqual([]);
			expect(manager.listStatus().find((s) => s.server === "needs-key")?.enabled).toBe(false);
		} finally {
			delete process.env.CATALOG_API_KEY_TEST;
		}
	});

	it("enables only the explicitly public no-auth setup-ready catalog row; requires-setup and unknown fail closed", async () => {
		const manager = new McpManager({
			authStorage,
			getServiceCatalog: () => [
				{
					serviceId: "public-docs",
					label: "Public Docs",
					aliases: [],
					transport: { type: "http", url: "https://public.example/mcp" },
					authStrategy: "none",
					setup: { status: "ready" },
					metadataReviewed: true,
					legacyBuiltin: false,
				},
				{
					serviceId: "blocked-setup",
					label: "Blocked Setup",
					aliases: [],
					transport: { type: "http", url: "https://blocked.example/mcp" },
					authStrategy: "none",
					setup: { status: "requires-setup", reason: "manual setup" },
					metadataReviewed: true,
					legacyBuiltin: false,
				},
				{
					serviceId: "unknown-auth",
					label: "Unknown Auth",
					aliases: [],
					transport: { type: "http", url: "https://unknown.example/mcp" },
					authStrategy: "unknown",
					setup: { status: "ready" },
					metadataReviewed: true,
					legacyBuiltin: false,
				},
			],
		});
		expect(manager.getEnabledPersistentGenericServers()).toEqual(["public-docs"]);
		expect(manager.listStatus().find((s) => s.server === "blocked-setup")?.enabled).toBe(false);
		expect(manager.listStatus().find((s) => s.server === "unknown-auth")?.enabled).toBe(false);
		const handlers = manager.hostHandlers();
		await expect(handlers["mcp.config"]({ server: "public-docs" })).resolves.toEqual({
			type: "http",
			url: "https://public.example/mcp",
		});
		await expect(handlers["mcp.config"]({ server: "blocked-setup" })).resolves.toEqual({});
		await expect(handlers["mcp.config"]({ server: "unknown-auth" })).resolves.toEqual({});
	});

	it("oauth grant matrix: expired-no-refresh, wrong-type, and empty-access credentials are not authed; refreshable ones are", async () => {
		const catalog: McpServiceDescriptor[] = [
			{
				serviceId: "svc-a",
				label: "Service A",
				aliases: [],
				transport: { type: "http", url: "https://svc-a.example/mcp" },
				authStrategy: "oauth",
				setup: { status: "ready" },
				metadataReviewed: true,
				legacyBuiltin: false,
			},
			{
				serviceId: "svc-b",
				label: "Service B",
				aliases: [],
				transport: { type: "http", url: "https://svc-b.example/mcp" },
				authStrategy: "oauth",
				setup: { status: "ready" },
				metadataReviewed: true,
				legacyBuiltin: false,
			},
			{
				serviceId: "svc-c",
				label: "Service C",
				aliases: [],
				transport: { type: "http", url: "https://svc-c.example/mcp" },
				authStrategy: "oauth",
				setup: { status: "ready" },
				metadataReviewed: true,
				legacyBuiltin: false,
			},
		];
		// svc-a: expired WITHOUT refresh -> refused.
		authStorage.set("mcp:svc-a", {
			type: "oauth",
			access: "expired",
			refresh: "",
			expires: Date.now() - 1000,
			endpoint: "https://svc-a.example/mcp",
		});
		// svc-b: expired WITH refresh -> refreshable, stays eligible.
		authStorage.set("mcp:svc-b", {
			type: "oauth",
			access: "expiring",
			refresh: "r",
			expires: Date.now() - 1000,
			endpoint: "https://svc-b.example/mcp",
		});
		// svc-c: wrong-type entry at the MCP key -> refused.
		authStorage.set("mcp:svc-c", { type: "api_key", key: "not-an-oauth-grant" });
		const manager = new McpManager({ authStorage, getServiceCatalog: () => catalog });
		expect(manager.listStatus().find((s) => s.server === "svc-a")?.enabled).toBe(false);
		expect(manager.listStatus().find((s) => s.server === "svc-b")?.enabled).toBe(true);
		expect(manager.listStatus().find((s) => s.server === "svc-c")?.enabled).toBe(false);
		const handlers = manager.hostHandlers();
		await expect(handlers["mcp.config"]({ server: "svc-b" })).resolves.toEqual({
			type: "http",
			url: "https://svc-b.example/mcp",
			oauth: true,
		});
		await expect(handlers["mcp.config"]({ server: "svc-c" })).resolves.toEqual({});

		// Empty access on the oauth type is equally refused.
		authStorage.set("mcp:svc-c", {
			type: "oauth",
			access: "",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://svc-c.example/mcp",
		} as never);
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "svc-c")?.enabled).toBe(false);
	});

	it("a configured bearer env var is the ONLY credential source: no stale-OAuth fall-through when it is unset", () => {
		// A stale OAuth grant sits under the id, but the server's configured
		// credential source is the env var — while unset, nothing is enabled.
		authStorage.set("mcp:beared", {
			type: "oauth",
			access: "stale",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://beared.example/mcp",
		});
		const manager = new McpManager({
			authStorage,
			getServiceCatalog: () => [],
			getUserServers: () => ({
				beared: { type: "http", url: "https://beared.example/mcp", bearerTokenEnvVar: "BEARED_TOKEN_TEST" },
			}),
		});
		expect(manager.listStatus().find((s) => s.server === "beared")?.enabled).toBe(false);
		expect(manager.getEnabledPersistentGenericServers()).toEqual([]);

		process.env.BEARED_TOKEN_TEST = "present";
		try {
			manager.refresh();
			expect(manager.listStatus().find((s) => s.server === "beared")?.enabled).toBe(true);
		} finally {
			delete process.env.BEARED_TOKEN_TEST;
		}
	});
});
async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for a background condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const CATALOG_SERVICE: McpServiceDescriptor = {
	serviceId: "acme",
	label: "Acme",
	aliases: [],
	transport: { type: "http", url: "https://mcp.acme.test/mcp" },
	authStrategy: "oauth",
	setup: { status: "ready" },
	metadataReviewed: true,
	legacyBuiltin: false,
};

const LEGACY_CATALOG: McpServiceDescriptor[] = [
	{
		serviceId: "linear",
		label: "Linear",
		aliases: [],
		transport: { type: "http", url: "https://mcp.linear.app/mcp" },
		authStrategy: "oauth",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: true,
	},
	{
		serviceId: "notion",
		label: "Notion",
		aliases: [],
		transport: { type: "http", url: "https://mcp.notion.com/mcp" },
		authStrategy: "oauth",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: true,
	},
];
describe("McpManager service catalog handlers", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	let probeCalls: Array<{ url: string; token: string }>;
	let probeResult: { ok: true; toolCount: number } | { ok: false; error: "http-unauthorized" };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		probeCalls = [];
		probeResult = { ok: true, toolCount: 3 };
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createManager(options: Partial<ConstructorParameters<typeof McpManager>[0]> = {}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			// Exact-list assertions pin the legacy built-in slice; individual
			// tests override this with their own catalogs.
			getServiceCatalog: () => LEGACY_CATALOG,
			probeConnection: async (probeOptions) => {
				probeCalls.push({ url: probeOptions.url, token: await probeOptions.getToken() });
				return probeResult;
			},
			...options,
		});
	}

	it("lists plugins with statuses, strict status filtering, and honest pagination", async () => {
		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.notion.com/mcp",
		});
		const manager = createManager({ noBackgroundVerification: true });
		const handlers = manager.hostHandlers();

		const all = (await handlers["mcp.list_plugins"]({})) as {
			plugins: Array<{ serviceId: string; connectionStatus: string }>;
			nextCursor: string | null;
		};
		expect(all.plugins.map((plugin) => `${plugin.serviceId}:${plugin.connectionStatus}`).sort()).toEqual([
			"linear:not_connected",
			"notion:pending",
		]);
		expect(all.nextCursor).toBeNull();

		const connected = (await handlers["mcp.list_plugins"]({
			connectionStatus: "not_connected",
			limit: 1,
		})) as { plugins: Array<{ serviceId: string }>; nextCursor: string | null };
		expect(connected.plugins).toHaveLength(1);
		expect(connected.plugins[0]).toMatchObject({ serviceId: "linear" });
		expect(connected.nextCursor).toBeNull();

		const page = (await handlers["mcp.list_plugins"]({ limit: 1 })) as {
			plugins: Array<{ serviceId: string }>;
			nextCursor: string | null;
		};
		expect(page.plugins).toHaveLength(1);
		expect(page.nextCursor).toBe("1");

		await expect(handlers["mcp.list_plugins"]({ connectionStatus: "bogus" })).rejects.toThrow(
			"unknown connectionStatus",
		);
		await expect(handlers["mcp.list_plugins"]({ limit: 0 })).rejects.toThrow("positive integer");
		await expect(handlers["mcp.list_plugins"]({ cursor: "bogus" })).rejects.toThrow("invalid cursor");
	});

	it("searches plugins boundedly and rejects empty queries", async () => {
		const manager = createManager({ noBackgroundVerification: true });
		const handlers = manager.hostHandlers();
		const result = (await handlers["mcp.search_plugins"]({ query: "NOTION" })) as {
			plugins: Array<{ serviceId: string }>;
		};
		expect(result.plugins.map((plugin) => plugin.serviceId)).toEqual(["notion"]);
		await expect(handlers["mcp.search_plugins"]({ query: "  " })).rejects.toThrow("non-empty query");
	});

	it("lists connections including pending catalog grants, user servers, and ACP servers", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.linear.app/mcp",
		});
		const manager = createManager({
			noBackgroundVerification: true,
			getUserServers: () => ({ custom: { type: "http", url: "https://custom.test/mcp" } }),
		});
		manager.replaceAcpServers(
			[{ name: "acp-tool", type: "http", url: "https://acp.test/mcp", headers: {} }],
			"owner",
		);
		const handlers = manager.hostHandlers();
		const result = (await handlers["mcp.list_connections"]({})) as {
			connections: Array<{ connectionId: string; source: string; status: string; transport: string }>;
		};
		expect(result.connections.map((c) => `${c.connectionId}:${c.source}:${c.status}:${c.transport}`)).toEqual([
			"acp-tool:acp:connected:http",
			"custom:user:connected:http",
			"linear:catalog:pending:http",
		]);
	});

	it("records an error (reconnect) once when demand-driven verification finds an unbound grant", async () => {
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "legacy-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const handlers = manager.hostHandlers();
		await handlers["mcp.list_plugins"]({});
		// The fire-and-forget verification settles quickly; poll for the record.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const record = store.get("acme");
		expect(record?.status).toBe("error");
		expect(record?.lastError).toBe("credential-unbound");
		expect(probeCalls).toEqual([]);
		// The next listing does not rewrite the record.
		await handlers["mcp.list_plugins"]({});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(store.get("acme")?.updatedAt).toBe(record?.updatedAt);
	});

	it("serves per-account connection ids as their own dispatchable integrations", async () => {
		// A second account "acme-2" with its own bound credential.
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "acct-2",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await store.flush();
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		// The alias gets its own provider (the add-account login targets it).
		expect(getOAuthProvider("mcp:acme-2")).toBeDefined();
		// Inventory includes the alias account once verified...
		expect(manager.getEnabledPersistentGenericServers()).toContain("acme-2");
		const record = await manager.verifyConnection("acme-2");
		expect(record.status).toBe("connected");
		expect(record.connectionId).toBe("acme-2");
		expect(record.serviceId).toBe("acme");
		expect(probeCalls).toEqual([{ url: "https://mcp.acme.test/mcp", token: "acct-2" }]);
	});

	it("full account lifecycle: second account listed and remains manageable after the default disconnects", async () => {
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "primary",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "second",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: at,
			toolCount: 2,
			createdAt: at,
			updatedAt: at,
		});
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "pending",
			createdAt: at,
			updatedAt: at,
		});
		await store.flush();
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const handlers = manager.hostHandlers();

		// Reload: both accounts are listed by the inventory.
		manager.refresh();
		const connections = (await handlers["mcp.list_connections"]({})) as {
			connections: Array<{ connectionId: string; status: string }>;
		};
		const ids = connections.connections.map((connection) => connection.connectionId).sort();
		expect(ids).toEqual(["acme", "acme-2"]);

		// The default account disconnects: logout + record removal + reload.
		authStorage.remove("mcp:acme");
		store.remove("acme");
		await store.flush();
		manager.refresh();

		// The second account is STILL listed, dispatchable, and verifiable.
		const after = (await handlers["mcp.list_connections"]({})) as {
			connections: Array<{ connectionId: string; status: string }>;
		};
		expect(after.connections.map((connection) => connection.connectionId)).toEqual(["acme-2"]);
		expect(manager.getEnabledPersistentGenericServers()).toContain("acme-2");
		const verified = await manager.verifyConnection("acme-2");
		expect(verified.status).toBe("connected");
		expect(verified.serviceId).toBe("acme");
	});

	it("drops an alias account's provider when its record is removed", async () => {
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "pending",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await store.flush();
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		expect(getOAuthProvider("mcp:acme-2")).toBeDefined();
		store.remove("acme-2");
		await store.flush();
		manager.refresh();
		expect(getOAuthProvider("mcp:acme-2")).toBeUndefined();
	});

	it("reconciles owned providers atomically: override removal restores the catalog provider in one refresh", () => {
		const getServices = () => [CATALOG_SERVICE];
		let userServers: Record<string, { type: "http"; url: string; oauth: boolean }> = {
			acme: { type: "http", url: "https://user-override.test/mcp", oauth: true },
		};
		const manager = createManager({ getServiceCatalog: getServices, getUserServers: () => userServers });
		manager.registerAllProviders();
		expect(getOAuthProvider("mcp:acme")?.name).toBe("acme");

		// Removing the user override must restore the catalog provider in ONE refresh.
		userServers = {};
		manager.refresh();
		manager.registerAllProviders();
		expect(getOAuthProvider("mcp:acme")?.name).toBe("Acme");
	});

	it("verifies pending connections on demand: a listing triggers a real handshake and the next listing reports it", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.linear.app/mcp",
		});
		const manager = createManager();
		const handlers = manager.hostHandlers();

		const before = (await handlers["mcp.list_plugins"]({ connectionStatus: "pending" })) as {
			plugins: Array<{ serviceId: string; connectionStatus: string }>;
		};
		expect(before.plugins[0]).toMatchObject({ serviceId: "linear", connectionStatus: "pending" });

		// The demand-driven background probe runs against the bound endpoint with the token.
		await waitForCondition(() => store.get("linear")?.status === "connected");
		expect(probeCalls).toEqual([{ url: "https://mcp.linear.app/mcp", token: "tok" }]);

		const after = (await handlers["mcp.list_plugins"]({})) as {
			plugins: Array<{ serviceId: string; connectionStatus: string; toolCount?: number }>;
		};
		expect(after.plugins.find((plugin) => plugin.serviceId === "linear")).toMatchObject({
			connectionStatus: "connected",
			toolCount: 3,
		});
	});

	it("keeps verification failures recoverable: a rejected credential records error without deleting the grant", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.linear.app/mcp",
		});
		probeResult = { ok: false, error: "http-unauthorized" };
		const manager = createManager();
		const record = await manager.verifyConnection("linear");
		expect(record.status).toBe("error");
		expect(record.lastError).toBe("http-unauthorized");
		expect(authStorage.get("mcp:linear")).toBeDefined();
		expect(store.get("linear")?.lastError).not.toContain("mcp.linear.app");
	});

	it("reloads connection records written by the interactive client on refresh()", async () => {
		const manager = createManager({ noBackgroundVerification: true });
		const clientStore = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.notion.com/mcp",
		});
		clientStore.upsert({
			connectionId: "notion",
			serviceId: "notion",
			endpoint: "https://mcp.notion.com/mcp",
			label: "Notion",
			status: "connected",
			verifiedAt: Date.now(),
			toolCount: 9,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await clientStore.flush();
		manager.refresh();

		const handlers = manager.hostHandlers();
		const connections = (await handlers["mcp.list_connections"]({})) as {
			connections: Array<{ connectionId: string; status: string }>;
		};
		expect(connections.connections.find((connection) => connection.connectionId === "notion")).toMatchObject({
			status: "connected",
		});
	});

	it("serves custom catalog providers: user-owned non-bundled ids coexist with catalog cards", async () => {
		const manager = createManager({
			noBackgroundVerification: true,
			getServiceCatalog: () => [CATALOG_SERVICE],
			getUserServers: () => ({
				acme: { type: "http", url: "https://custom.acme.test/mcp", oauth: true },
			}),
		});
		const handlers = manager.hostHandlers();
		const plugins = (await handlers["mcp.list_plugins"]({})) as {
			plugins: Array<{ serviceId: string; source: string }>;
		};
		// The user's server owns the id; no duplicate catalog card is listed.
		expect(plugins.plugins).toEqual([expect.objectContaining({ serviceId: "acme", source: "user" })]);
		// The user provider is registered against the user's URL, not the catalog endpoint.
		expect(getOAuthProvider("mcp:acme")).toMatchObject({ name: "acme" });
	});

	it("registers OAuth providers for connectable non-bundled catalog services, never for setup-required ones", () => {
		createManager({
			noBackgroundVerification: true,
			getServiceCatalog: () => [
				CATALOG_SERVICE,
				{
					...CATALOG_SERVICE,
					serviceId: "brandapp",
					label: "BrandApp",
					setup: { status: "requires-setup", reason: "Requires a developer app." },
				},
			],
		});
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		expect(getOAuthProvider("mcp:brandapp")).toBeUndefined();
	});

	it("exposes mcp.connect only with an explicit approver and maps its result", async () => {
		const bare = createManager({ noBackgroundVerification: true });
		expect(Object.keys(bare.hostHandlers())).not.toContain("mcp.connect");

		const approvals: string[] = [];
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const manager = createManager({
			noBackgroundVerification: true,
			getServiceCatalog: () => [CATALOG_SERVICE],
			beginConnect: async (serviceId) => {
				approvals.push(serviceId);
				return serviceId === "acme";
			},
		});
		const handlers = manager.hostHandlers();
		// An approved login whose handshake fails reports the failure honestly.
		probeResult = { ok: false, error: "http-unauthorized" };
		const failed = (await handlers["mcp.connect"]({ serviceId: "acme" })) as {
			status: string;
			message?: string;
		};
		expect(failed.status).toBe("error");
		expect(failed.message).toBe("http-unauthorized");

		// A verified handshake is the only "connected" claim, with the tool count.
		probeResult = { ok: true, toolCount: 3 };
		const connected = await handlers["mcp.connect"]({ serviceId: "acme" });
		expect(connected).toEqual({ status: "connected", connectionId: "acme", toolCount: 3 });
		expect(approvals).toEqual(["acme", "acme"]);

		await expect(handlers["mcp.connect"]({ serviceId: "missing" })).rejects.toThrow("Unknown MCP service");
		await expect(handlers["mcp.connect"]({})).rejects.toThrow("requires a serviceId");
	});
});
