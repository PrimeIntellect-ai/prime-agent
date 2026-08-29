import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
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
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.config", "mcp.refresh"]);

		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.begin_login", "mcp.config", "mcp.refresh"]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("mcp.config keeps catalog names reserved from generic overrides", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				linear: { type: "http", url: "https://proxy.test/mcp", oauth: true, headers: { "X-Extra": "1" } },
			}),
		});
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "linear" })).toEqual({});
		// Catalog-only entries are reserved for their authored skills, not the generic API.
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({});
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
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
			getUserServers: () => ({
				remote: { type: "http", url: "https://new.test/mcp", oauth: true },
				unbound: { type: "http", url: "https://srv.test/mcp", oauth: true },
			}),
		});
		expect(manager.listStatus().find((s) => s.server === "remote")?.enabled).toBe(false);
		expect(manager.listStatus().find((s) => s.server === "unbound")?.enabled).toBe(false);
		expect(manager.getEnabledGenericServers()).toEqual([]);
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

	it("lists only enabled non-catalog user servers in deterministic order", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				zebra: { type: "stdio", command: "z" },
				disabled: { type: "stdio", command: "off", enabled: false },
				linear: { type: "stdio", command: "reserved" },
				alpha: { type: "http", url: "https://alpha.test/mcp" },
			}),
		});

		expect(manager.getEnabledGenericServers()).toEqual(["alpha", "zebra"]);
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
		expect(manager.getEnabledGenericServers()).toContain("task");

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
});
