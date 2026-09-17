import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
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

	it("keeps MCP providers registered after ModelRegistry.refresh resets the registry, via the reset hook", () => {
		// Built-in catalog providers survive reset; user-declared servers survive through the production reset hook.
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		registry.setOnOAuthProvidersReset(() => manager.registerAllProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // calls resetOAuthProviders(); hook + built-ins must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});
	// The user-declared server's reset-hook re-registration is folded into
	// "keeps MCP providers registered after ModelRegistry.refresh resets the registry, via the reset hook" above.
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

		authStorage.set("mcp:notion", grant("tok", "https://mcp.notion.com/mcp", Date.now()));
		// Stored credentials put the catalog service on the generic route.
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({
			type: "http",
			url: "https://mcp.notion.com/mcp",
			oauth: true,
		});
	});

	// A shadow credential never authorizes a reserved name: pinned with the reserved-name matrix below and in
	// mcp-catalog-eligibility.test.ts ("a reserved builtin name with a stored pasted token still fails closed under a
	// user shadow").

	// Unbound/cross-endpoint grants fail closed: pinned across the shared predicate, prompt, dispatch, and view in
	// mcp-catalog-eligibility.test.ts ("OAuth grant states agree across the shared predicate, prompt, dispatch, and the
	// picker view").

	// Bearer-env eligibility (including the stale-OAuth fall-through refusal) is pinned in
	// mcp-catalog-eligibility.test.ts ("user-declared servers keep their semantics, but a configured bearer env var is
	// the ONLY credential source").

	it("lists enabled generic servers including connected catalog services in deterministic order", () => {
		authStorage.set("mcp:notion", grant("tok", "https://mcp.notion.com/mcp", Date.now()));
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

	// The empty-auth sweep over the REAL catalog is pinned in mcp-catalog-eligibility.test.ts ("sweeps the REAL catalog:
	// no row is enabled without proven credentials").

	// Field-id env vars are never inferred as credentials: pinned on the REAL catalog in mcp-catalog-eligibility.test.ts
	// ("the real aws-devops-agent row stays unauthenticated even when its setup env var is present").

	// Strategy fail-closed semantics are pinned ONCE across prompt, dispatch,
	// and view in mcp-catalog-eligibility.test.ts ("%s across prompt and dispatch").

	// The oauth grant-state matrix is pinned ONCE, across the shared predicate, prompt, dispatch, and the picker view,
	// in mcp-catalog-eligibility.test.ts.

	it("a configured bearer env var is the ONLY credential source: no stale-OAuth fall-through when it is unset", () => {
		// A stale OAuth grant sits under the id, but the server's configured
		// credential source is the env var — while unset, nothing is enabled.
		authStorage.set("mcp:beared", grant("stale", "https://beared.example/mcp", Date.now()));
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
/**
 * Deterministic settle for demand-driven background verification: the store's
 * queueVerifyResult call is the concrete signal that the verification result
 * was accepted, and the trailing flush chains behind the durable write — no
 * timer, no polling.
 */
function verifyResultSettled(store: McpConnectionStore): { queued: Promise<void>; flush: () => Promise<void> } {
	let queued!: () => void;
	const signal = new Promise<void>((resolve) => {
		queued = resolve;
	});
	const real = store.queueVerifyResult.bind(store);
	vi.spyOn(store, "queueVerifyResult").mockImplementation((...args: Parameters<typeof real>) => {
		queued();
		return real(...args);
	});
	return { queued: signal, flush: () => store.flush() };
}

/** A synthetic OAuth grant bound to the given endpoint (no endpoint = unbound). */
const grant = (access: string, endpoint?: string, at = Date.now()) => ({
	type: "oauth" as const,
	access,
	refresh: "r",
	expires: at + 3600_000,
	...(endpoint !== undefined ? { endpoint } : {}),
});

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

describe("ENG-6108 reserved ownership and durable repair endpoints (manager)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	let probeCalls: Array<{ url: string; token: string }>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-ownership-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		probeCalls = [];
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createManager(options: Partial<ConstructorParameters<typeof McpManager>[0]> = {}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			getServiceCatalog: () => LEGACY_CATALOG,
			probeConnection: async (probeOptions) => {
				probeCalls.push({ url: probeOptions.url, token: await probeOptions.getToken() });
				return { ok: true, toolCount: 2 };
			},
			...options,
		});
	}

	it("a conflicting reserved-name declaration is never dispatchable: config, probe, and login all refuse", async () => {
		const manager = createManager({
			noBackgroundVerification: true,
			getUserServers: () => ({ linear: { type: "http", url: "https://shadow.example/mcp", oauth: true } }),
		});
		const handlers = manager.hostHandlers();
		await expect(handlers["mcp.config"]({ server: "linear" })).resolves.toEqual({});
		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow();
		await expect(manager.verifyConnection("linear")).rejects.toThrow(
			"Rename or remove the conflicting server settings",
		);
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("linear");
		// A shadow credential can never authorize dispatch either.
		authStorage.set("mcp:linear", grant("shadow", "https://shadow.example/mcp", Date.now()));
		manager.refresh();
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("linear");
		expect(manager.getDisabledBuiltinSkillOverrides()).toContain("-linear/SKILL.md");
	});

	it("a same-name enabled:false declaration disables the builtin slot without deleting it", () => {
		const manager = createManager({
			noBackgroundVerification: true,
			getUserServers: () => ({ linear: { type: "http", url: "https://mcp.linear.app/mcp", enabled: false } }),
		});
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
		manager.refresh();
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("linear");
		expect(manager.getDisabledBuiltinSkillOverrides()).toContain("-linear/SKILL.md");
	});

	it("a canonical-equivalent declaration keeps the builtin integration live", async () => {
		const manager = createManager({
			noBackgroundVerification: true,
			getUserServers: () => ({
				linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: true },
			}),
		});
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
		manager.refresh();
		expect(manager.getEnabledPersistentGenericServers()).toContain("linear");
		await expect(manager.verifyConnection("linear")).resolves.toMatchObject({ status: "connected" });
	});

	it("an installed record pins its durable endpoint for verification and dispatch when the catalog URL changes", async () => {
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://old.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		authStorage.set("mcp:acme", grant("tok", "https://old.acme.test/mcp", Date.now()));
		const manager = createManager({
			noBackgroundVerification: true,
			getServiceCatalog: () => [
				{ ...CATALOG_SERVICE, transport: { type: "http", url: "https://new.acme.test/mcp" } },
			],
		});
		// Verification probes the DURABLE saved endpoint, never the changed URL.
		await expect(manager.verifyConnection("acme")).resolves.toMatchObject({
			status: "connected",
			endpoint: "https://old.acme.test/mcp",
		});
		expect(probeCalls).toEqual([{ url: "https://old.acme.test/mcp", token: "tok" }]);
		// Dispatch config carries the same durable endpoint.
		const config = (await manager.hostHandlers()["mcp.config"]({ server: "acme" })) as {
			url?: string;
		};
		expect(config.url).toBe("https://old.acme.test/mcp");
	});

	it("a credential-only account never retargets automatic dispatch to a stored endpoint", async () => {
		authStorage.set("mcp:acme", grant("tok", "https://old.acme.test/mcp", Date.now()));
		const manager = createManager({ noBackgroundVerification: true, getServiceCatalog: () => [CATALOG_SERVICE] });
		const handlers = manager.hostHandlers();
		// A cross-endpoint credential-only grant authorizes nothing at the
		// current service URL — dispatch config stays absent.
		await expect(handlers["mcp.config"]({ server: "acme" })).resolves.toEqual({});
		// A bound grant authorizes dispatch at the CURRENT service URL only — never at a stored credential endpoint.
		authStorage.set("mcp:acme", grant("tok", "https://mcp.acme.test/mcp", Date.now()));
		manager.refresh();
		const bound = (await handlers["mcp.config"]({ server: "acme" })) as { url?: string };
		expect(bound.url).toBe("https://mcp.acme.test/mcp");
	});

	it("background verification never probes an account claimed by a live attempt", async () => {
		await store.reserveConnectionId({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "pending",
			attemptId: "live-owner",
			createdAt: 1,
			updatedAt: 1,
		});
		authStorage.set("mcp:acme", grant("tok", "https://mcp.acme.test/mcp", Date.now()));
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const handlers = manager.hostHandlers();
		await handlers["mcp.list_plugins"]({});
		// The claimed-account skip happens in the scan's synchronous prefix (fired before the listing resolves), so the
		// settled outcome is exact: no probe may ever start.
		expect(probeCalls).toEqual([]);
	});
});

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
			// Exact-list assertions pin the legacy built-in slice; individual tests override this with their own catalogs.
			getServiceCatalog: () => LEGACY_CATALOG,
			probeConnection: async (probeOptions) => {
				probeCalls.push({ url: probeOptions.url, token: await probeOptions.getToken() });
				return probeResult;
			},
			...options,
		});
	}

	it("lists plugins with statuses, strict status filtering, and honest pagination", async () => {
		authStorage.set("mcp:notion", grant("tok", "https://mcp.notion.com/mcp", Date.now()));
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
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
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
		// The unusable-grant record is queued and flushed in the scan's
		// synchronous prefix; the chained flush confirms the durable write.
		await store.flush();
		const record = store.get("acme");
		expect(record?.status).toBe("error");
		expect(record?.lastError).toBe("credential-unbound");
		expect(probeCalls).toEqual([]);
		// The next listing does not rewrite the record: its scan sees the
		// existing record, so nothing is queued and the timestamp is settled.
		await handlers["mcp.list_plugins"]({});
		await store.flush();
		expect(store.get("acme")?.updatedAt).toBe(record?.updatedAt);
	});

	it("serves per-account connection ids as their own dispatchable integrations", async () => {
		// A second account "acme-2" with its own bound credential.
		authStorage.set("mcp:acme-2", grant("acct-2", "https://mcp.acme.test/mcp", Date.now()));
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
		authStorage.set("mcp:acme", grant("primary", "https://mcp.acme.test/mcp", Date.now()));
		authStorage.set("mcp:acme-2", grant("second", "https://mcp.acme.test/mcp", Date.now()));
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

	it("alias accounts mirror the parent's classification: public no-auth stays credential-free, requires-setup gains no OAuth provider", async () => {
		const at = Date.now();
		const descriptors: McpServiceDescriptor[] = [
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
				serviceId: "gated-oauth",
				label: "Gated OAuth",
				aliases: [],
				transport: { type: "http", url: "https://gated.example/mcp" },
				authStrategy: "oauth",
				setup: { status: "requires-setup", reason: "manual setup" },
				metadataReviewed: true,
				legacyBuiltin: false,
			},
		];
		for (const [connectionId, serviceId, endpoint] of [
			["public-docs-2", "public-docs", "https://public.example/mcp"],
			["gated-oauth-2", "gated-oauth", "https://gated.example/mcp"],
		] as const) {
			store.upsert({
				connectionId,
				serviceId,
				endpoint,
				label: connectionId,
				status: "pending",
				createdAt: at,
				updatedAt: at,
			});
		}
		await store.flush();
		const manager = createManager({ noBackgroundVerification: true, getServiceCatalog: () => descriptors });
		// Neither parent qualifies for an OAuth provider, so neither alias does: a requires-setup or otherwise non-OAuth
		// service never offers a browser login to an extra account.
		expect(getOAuthProvider("mcp:public-docs-2")).toBeUndefined();
		expect(getOAuthProvider("mcp:gated-oauth-2")).toBeUndefined();
		// A public no-auth service's account is credential-free exactly like its
		// parent, so the alias record stays dispatchable with no credential.
		expect(manager.getEnabledPersistentGenericServers()).toContain("public-docs-2");
		// A requires-setup service's account stays closed like its parent until
		// setup completes — no OAuth provider, no phantom browser-login path.
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("gated-oauth-2");
		expect(manager.listStatus().find((s) => s.server === "gated-oauth-2")?.enabled).toBe(false);
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
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
		const settle = verifyResultSettled(store);
		const manager = createManager();
		const handlers = manager.hostHandlers();

		const before = (await handlers["mcp.list_plugins"]({ connectionStatus: "pending" })) as {
			plugins: Array<{ serviceId: string; connectionStatus: string }>;
		};
		expect(before.plugins[0]).toMatchObject({ serviceId: "linear", connectionStatus: "pending" });

		// The demand-driven background probe runs against the bound endpoint
		// with the token; its result lands durably before the next listing.
		await settle.queued;
		await settle.flush();
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
		authStorage.set("mcp:linear", grant("tok", "https://mcp.linear.app/mcp", Date.now()));
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
		authStorage.set("mcp:notion", grant("tok", "https://mcp.notion.com/mcp", Date.now()));
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

	// User-owned non-bundled ids coexisting with catalog cards is pinned at
	// the identity/provider sites in mcp-provider-identity.test.ts ("manager
	// catalog and per-account sites carry catalog advisory data") and by the
	// registry-reset preservation in mcp-service-safety.test.ts.

	// Connectable-vs-setup-required registration is pinned at the same
	// manager sites in mcp-provider-identity.test.ts and the
	// requires-setup fail-closed rule in mcp-catalog-eligibility.test.ts.

	it("exposes mcp.connect only with an explicit approver and maps its result", async () => {
		const bare = createManager({ noBackgroundVerification: true });
		expect(Object.keys(bare.hostHandlers())).not.toContain("mcp.connect");

		const approvals: string[] = [];
		authStorage.set("mcp:acme", grant("grant", "https://mcp.acme.test/mcp", Date.now()));
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

describe("McpManager token services (paste flow)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	const TOKEN_URL = "https://mcp.token-service.test/mcp";

	function tokenServiceFixture(overrides: Partial<McpServiceDescriptor> = {}): McpServiceDescriptor {
		return {
			serviceId: "token-service",
			label: "Token Service",
			aliases: [],
			transport: { type: "http", url: TOKEN_URL },
			authStrategy: "api_key",
			setup: {
				status: "requires-setup",
				reason: "paste your token",
				fields: [{ id: "TOKEN_SERVICE_TOKEN", label: "TOKEN_SERVICE_TOKEN", required: true, kind: "bearer-token" }],
			},
			metadataReviewed: false,
			legacyBuiltin: false,
			...overrides,
		};
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-token-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("demand-driven verification probes a token service only once its token is stored", async () => {
		authStorage.set("mcp:token-service", {
			type: "mcp_static_token",
			endpoint: TOKEN_URL,
			bearer: "ghp_stored-token",
			bearerFieldId: "TOKEN_SERVICE_TOKEN",
			createdAt: Date.now(),
		});
		const probes: string[] = [];
		const settle = verifyResultSettled(store);
		const manager = new McpManager({
			authStorage,
			connectionStore: store,
			getServiceCatalog: () => [tokenServiceFixture()],
			probeConnection: async (options) => {
				probes.push(await options.getToken());
				return { ok: true, toolCount: 7 };
			},
		});
		const listPlugins = manager.hostHandlers()["mcp.list_plugins"];
		expect(listPlugins).toBeDefined();
		await listPlugins({ limit: 10 });
		// The background handshake runs and lands in the record, not the console.
		await settle.queued;
		await settle.flush();
		expect(probes).toEqual(["ghp_stored-token"]);
		expect(store.get("token-service")).toMatchObject({ status: "connected", toolCount: 7 });
	});

	it("never probes a token service without a stored credential (no anonymous handshakes)", async () => {
		const probes: string[] = [];
		const manager = new McpManager({
			authStorage,
			connectionStore: store,
			getServiceCatalog: () => [tokenServiceFixture()],
			probeConnection: async (options) => {
				probes.push(await options.getToken());
				return { ok: true, toolCount: 7 };
			},
		});
		const listPlugins = manager.hostHandlers()["mcp.list_plugins"];
		expect(listPlugins).toBeDefined();
		await listPlugins({ limit: 10 });
		// The no-credential skip happens in the scan's synchronous prefix (fired before the listing resolves): no anonymous
		// handshake may ever start, and nothing is recorded.
		expect(probes).toEqual([]);
		expect(store.get("token-service")).toBeUndefined();
	});

	it("a second account of a token service gets no OAuth provider and stays token-based and dispatchable", async () => {
		const at = Date.now();
		store.upsert({
			connectionId: "token-service-2",
			serviceId: "token-service",
			endpoint: TOKEN_URL,
			label: "Token Service (token-service-2)",
			status: "pending",
			createdAt: at,
			updatedAt: at,
		});
		await store.flush();
		const probed: string[] = [];
		const manager = new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => [tokenServiceFixture()],
			probeConnection: async (options) => {
				probed.push(await options.getToken());
				return { ok: true, toolCount: 4 };
			},
		});
		// The alias mirrors the parent's token classification: NO OAuth provider is registered for the account id (or the
		// parent), so the extra account can never be offered a browser login whose grant isAuthed would reject.
		expect(getOAuthProvider("mcp:token-service")).toBeUndefined();
		expect(getOAuthProvider("mcp:token-service-2")).toBeUndefined();
		// A pasted static token stored under the ACCOUNT's own id — the same
		// credential source the parent accepts — makes it dispatchable.
		authStorage.set("mcp:token-service-2", {
			type: "mcp_static_token",
			endpoint: TOKEN_URL,
			bearer: "second-account-token",
			bearerFieldId: "TOKEN_SERVICE_TOKEN",
			createdAt: at,
		});
		expect(manager.getEnabledPersistentGenericServers()).toEqual(["token-service-2"]);
		// mcp.config serves the SAME token-based config shape the parent serves.
		const handlers = manager.hostHandlers();
		await expect(handlers["mcp.config"]({ server: "token-service-2" })).resolves.toEqual({
			type: "http",
			url: TOKEN_URL,
			credentialSource: "static-token",
		});
		// Verification probes with the stored pasted token, exactly like the parent.
		const record = await manager.verifyConnection("token-service-2");
		expect(record.status).toBe("connected");
		expect(record.serviceId).toBe("token-service");
		expect(probed).toEqual(["second-account-token"]);
	});
});
