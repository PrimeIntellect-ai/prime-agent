import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServiceEntry } from "@earendil-works/pi-ai/mcp";
import { createMcpOAuthProvider } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { MCP_PROBE_ERRORS } from "../src/core/mcp/connection-probe.js";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import {
	buildConnectionViews,
	buildPluginViews,
	decodePluginCursor,
	defaultServiceCatalogProvider,
	filterPluginViewsByStatus,
	type McpPluginView,
	type McpServiceDescriptor,
	mcpCredentialKey,
	mcpLoginEligibility,
	nextMcpConnectionId,
	pagePluginViews,
	resolveMcpOAuthIdentity,
	resolveMcpServiceCatalog,
	sameGrantToken,
	searchPluginViews,
	verifyMcpConnection,
} from "../src/core/mcp/service-catalog.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

function serviceFixture(overrides: Partial<McpServiceDescriptor> = {}): McpServiceDescriptor {
	return {
		serviceId: "acme",
		label: "Acme",
		aliases: [],
		transport: { type: "http", url: "https://mcp.acme.test/mcp" },
		authStrategy: "oauth",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: false,
		...overrides,
	};
}

function oauthCredential(expiresInMs = 3600_000, endpoint?: string) {
	return {
		type: "oauth" as const,
		access: "tok",
		refresh: "r",
		expires: Date.now() + expiresInMs,
		...(endpoint !== undefined ? { endpoint } : {}),
	};
}

describe("service catalog views", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-catalog-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists a catalog service as not connected and connectable without credentials", () => {
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			serviceId: "acme",
			label: "Acme",
			connectionStatus: "not_connected",
			connectable: true,
			usesOAuth: true,
			source: "catalog",
			connectionIds: [],
		});
	});

	it("keeps a cancelled account shell visible and connectable without implying an active login", async () => {
		await store.reserveConnectionId({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "pending",
			attemptId: "cancelled",
			createdAt: 1,
			updatedAt: 1,
		});
		await store.releaseClaim({ connectionId: "acme", attemptId: "cancelled" });
		const options = { services: [serviceFixture()], userServers: undefined, authStorage, connectionStore: store };
		const [view] = buildPluginViews(options);
		expect(view).toMatchObject({ connectionStatus: "not_connected", connectable: true, connectionIds: ["acme"] });
		expect(view.setupHint).toContain("settings kept");
		expect(buildConnectionViews(options)[0]).toMatchObject({ connectionId: "acme", status: "not_connected" });
		const userOptions = {
			...options,
			userServers: { acme: { type: "http" as const, url: "https://mcp.acme.test/mcp", oauth: true } },
		};
		expect(buildPluginViews(userOptions)[0]).toMatchObject({
			connectionIds: ["acme"],
			connectionStatus: "not_connected",
			connectable: true,
		});
		expect(buildConnectionViews(userOptions)[0]).toMatchObject({ connectionId: "acme", status: "not_connected" });
		expect(await store.claimConnectionId({ connectionId: "acme", attemptId: "retry" })).toBe(true);
		expect(await store.removeAccount({ connectionId: "acme", authCleanup: () => false })).toBe("removed");
	});

	it("never reports connected from a stored token alone: bound grants without a verified record stay pending", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("pending");
		expect(views[0]?.connectionIds).toEqual(["acme"]);
	});

	it("surfaces an unbound legacy grant as reconnect-required, never pending or connected", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("not bound to this endpoint");
	});

	it("surfaces a cross-endpoint grant as reconnect-required", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://other.example/mcp"));
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("not bound to this endpoint");
	});

	it("reports connected only with a verified connection record", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: Date.now(),
			toolCount: 7,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("connected");
		expect(views[0]?.toolCount).toBe(7);
		expect(views[0]?.verifiedAt).toBeGreaterThan(0);
	});

	it("treats wrong-type and empty-access credentials as no usable grant (shared rule with dispatch)", () => {
		authStorage.set(mcpCredentialKey("acme"), { type: "api_key", key: "not-an-oauth-grant" });
		const options = { services: [serviceFixture()], userServers: undefined, authStorage, connectionStore: store };
		// Wrong type, no record: never connected, never pending.
		expect(buildPluginViews(options)[0]?.connectionStatus).toBe("not_connected");

		authStorage.set(mcpCredentialKey("acme"), {
			type: "oauth",
			access: "",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		} as never);
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		// Empty access with a record: the stale connection reports Reconnect,
		// matching dispatch eligibility (the shared oauthGrantUsable rule).
		expect(buildPluginViews(options)[0]?.connectionStatus).toBe("error");
		expect(buildPluginViews(options)[0]?.setupHint).toContain("Stored credentials are missing");
	});

	it("downgrades a connected record when the credential disappears", () => {
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: Date.now(),
			toolCount: 3,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("Reconnect");
	});

	it("marks expired credentials without a refresh token as error", () => {
		authStorage.set(mcpCredentialKey("acme"), {
			type: "oauth",
			access: "tok",
			refresh: "",
			expires: Date.now() - 1000,
		});
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("error");
		// Error accounts stay listed so the account picker can manage them.
		expect(views[0]?.connectionIds).toEqual(["acme"]);
	});

	it("surfaces requires-setup services honestly without a connect action", () => {
		const views = buildPluginViews({
			services: [
				serviceFixture({
					serviceId: "brandapp",
					label: "BrandApp",
					setup: { status: "requires-setup", reason: "Requires a developer app." },
				}),
			],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("setup_required");
		expect(views[0]?.connectable).toBe(false);
		expect(views[0]?.setupHint).toBe("Requires a developer app.");
	});

	it("never offers Connect for sse, stdio, or http-template transports", () => {
		const views = buildPluginViews({
			services: [
				serviceFixture({ serviceId: "sse-svc", label: "SSE Svc", transport: { type: "other" } }),
				serviceFixture({ serviceId: "stdio-svc", label: "Stdio Svc", transport: { type: "stdio" } }),
				serviceFixture({ serviceId: "tmpl-svc", label: "Tmpl Svc", transport: { type: "http-template" } }),
			],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views.every((view) => view.connectionStatus === "setup_required" && !view.connectable)).toBe(true);
		expect(views.every((view) => typeof view.setupHint === "string" && view.setupHint.length > 0)).toBe(true);
	});

	it("offers explicit capability discovery for unverified imported OAuth candidates", () => {
		const views = buildPluginViews({
			services: [serviceFixture({ metadataReviewed: false })],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.unverified).toBe(true);
		expect(views[0]?.connectable).toBe(true);
		expect(views[0]?.setupHint).toContain("not been verified");
	});

	it("keeps user-declared servers working when the catalog adds the same id (user owns non-legacy ids)", () => {
		const userServers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://custom.acme.test/mcp", oauth: true },
		};
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers,
			authStorage,
			connectionStore: store,
		});
		// One card, owned by the user's server entry — no duplicate catalog card.
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({ source: "user", serviceId: "acme" });
	});

	it("ignores dead user shadows of bundled catalog ids (catalog owns the name)", () => {
		const userServers: Record<string, McpServerConfig> = {
			notion: { type: "http", url: "https://proxy.test/mcp", oauth: true },
		};
		const views = buildPluginViews({
			services: [serviceFixture({ serviceId: "notion", label: "Notion", legacyBuiltin: true })],
			userServers,
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({ source: "catalog", serviceId: "notion" });
	});

	it("builds connection views including pending and user servers, sorted by connectionId", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		const connections = buildConnectionViews({
			services: [serviceFixture()],
			userServers: {
				local: { type: "stdio", command: "node" },
				remote: { type: "http", url: "https://remote.test/mcp" },
			},
			authStorage,
			connectionStore: store,
			acpServers: [{ name: "acp-tool", type: "http" }],
		});
		expect(
			connections.map((connection) => `${connection.connectionId}:${connection.source}:${connection.status}`),
		).toEqual(["acme:catalog:pending", "acp-tool:acp:connected", "local:user:connected", "remote:user:connected"]);
	});

	it("searches by label, alias, and description with bounded results", () => {
		const views = buildPluginViews({
			services: [
				serviceFixture({ serviceId: "linear", label: "Linear", description: "Issue tracking" }),
				serviceFixture({ serviceId: "notion", label: "Notion", aliases: ["docs"] }),
				serviceFixture({ serviceId: "acme", label: "Acme" }),
			],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(searchPluginViews(views, "issue", 10).map((view) => view.serviceId)).toEqual(["linear"]);
		expect(searchPluginViews(views, "NOTION", 10).map((view) => view.serviceId)).toEqual(["notion"]);
		expect(searchPluginViews(views, "n", 10).map((view) => view.serviceId)).toEqual(["linear", "notion"]);
		expect(searchPluginViews(views, "n", 2)).toHaveLength(2);
		// An empty query is a bounded first page, not an exhaustive claim.
		expect(searchPluginViews(views, "", 2)).toHaveLength(2);
	});

	it("filters strictly by connection status and paginates with honest cursors", () => {
		const views = buildPluginViews({
			services: [
				serviceFixture({ serviceId: "a", label: "A" }),
				serviceFixture({ serviceId: "b", label: "B" }),
				serviceFixture({ serviceId: "c", label: "C", setup: { status: "requires-setup" } }),
			],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		const notConnected = filterPluginViewsByStatus(views, "not_connected");
		expect(notConnected.map((view) => view.serviceId)).toEqual(["a", "b"]);

		const page1 = pagePluginViews(notConnected, decodePluginCursor(undefined), 1);
		expect(page1.plugins.map((view) => view.serviceId)).toEqual(["a"]);
		expect(page1.nextCursor).toBe("1");
		const page2 = pagePluginViews(notConnected, decodePluginCursor(page1.nextCursor), 1);
		expect(page2.plugins.map((view) => view.serviceId)).toEqual(["b"]);
		expect(page2.nextCursor).toBeNull();
		expect(() => decodePluginCursor("bogus")).toThrow("invalid cursor");
	});
});

describe("ENG-6108 active login ownership (distinct from pending verification)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-login-pending-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("an active pending login (attemptId, no grant) stays visible and suppresses Connect actions, never reads as missing credentials", async () => {
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
		const options = { services: [serviceFixture()], userServers: undefined, authStorage, connectionStore: store };
		const [view] = buildPluginViews(options);
		// The account row is visible and honestly pending — but the aggregate
		// never offers a second Connect/Reconnect while an attempt owns it.
		expect(view.connectionStatus).toBe("pending");
		expect(view.loginPending).toBe(true);
		expect(view.connectable).toBe(false);
		expect(view.addAccountAllowed).toBe(false);
		expect(view.connectionIds).toEqual(["acme"]);
		const [inventory] = buildConnectionViews(options);
		expect(inventory).toMatchObject({ connectionId: "acme", status: "pending", loginPending: true });
	});

	it("a claimed reconnect on a connected record is active ownership too: Remove stays available, Reconnect does not", async () => {
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
		await expect(store.claimConnectionId({ connectionId: "acme", attemptId: "reconnect-owner" })).resolves.toBe(true);
		const options = { services: [serviceFixture()], userServers: undefined, authStorage, connectionStore: store };
		const [view] = buildPluginViews(options);
		expect(view.connectionStatus).toBe("pending");
		expect(view.loginPending).toBe(true);
		expect(view.connectable).toBe(false);
		// The account row itself stays listed for Remove; the state hints at the
		// live attempt instead of a missing-credential Reconnect.
		expect(view.setupHint).toContain("Login in progress");
	});
});

describe("ENG-6108 reserved builtin ownership classification", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-reserved-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const builtin = (): McpServiceDescriptor =>
		serviceFixture({ serviceId: "linear", label: "Linear", legacyBuiltin: true, metadataReviewed: true });

	it("a canonical-equivalent user declaration refers to the builtin: the catalog view stays connectable", () => {
		const views = buildPluginViews({
			services: [builtin()],
			userServers: {
				linear: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
			},
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			serviceId: "linear",
			connectionStatus: "not_connected",
			connectable: true,
			source: "catalog",
		});
	});

	it("a same-name enabled:false declaration disables the reserved slot — no silent reactivation", () => {
		const views = buildPluginViews({
			services: [builtin()],
			userServers: {
				linear: { type: "http", url: "https://mcp.acme.test/mcp", enabled: false },
			},
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			serviceId: "linear",
			connectionStatus: "disabled",
			connectable: false,
		});
		expect(views[0].setupHint).toContain("Disabled in settings");
	});

	it("a conflicting same-name declaration is an honest error with a rename hint, never Connected-but-undispatchable", () => {
		const views = buildPluginViews({
			services: [builtin()],
			userServers: {
				linear: { type: "http", url: "https://other.example/mcp", oauth: true },
			},
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			serviceId: "linear",
			connectionStatus: "error",
			connectable: false,
			addAccountAllowed: false,
		});
		expect(views[0].setupHint).toContain("Rename or remove the conflicting server settings");
		// The conflict also surfaces in the connection inventory with the same
		// diagnostic, so dispatch-target listings never imply a working alias.
		const [inventory] = buildConnectionViews({
			services: [builtin()],
			userServers: {
				linear: { type: "http", url: "https://other.example/mcp", oauth: true },
			},
			authStorage,
			connectionStore: store,
		});
		expect(inventory).toMatchObject({ connectionId: "linear", status: "error" });
		expect(inventory.setupHint).toContain("Rename or remove the conflicting server settings");
	});

	it("an installed account under a conflicting reserved name stays listed for cleanup", async () => {
		const now = Date.now();
		store.upsert({
			connectionId: "linear",
			serviceId: "linear",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Linear",
			status: "connected",
			verifiedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		const userServers = { linear: { type: "http" as const, url: "https://other.example/mcp", oauth: true } };
		const [inventory] = buildConnectionViews({
			services: [builtin()],
			userServers,
			authStorage,
			connectionStore: store,
		});
		expect(inventory).toMatchObject({ connectionId: "linear", status: "error" });
		// The saved account remains removable through the store API.
		expect(await store.removeAccount({ connectionId: "linear", authCleanup: () => false })).toBe("removed");
	});
});

describe("ENG-6108 per-operation login eligibility (fresh vs exact-id repair)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-eligibility-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("a changed catalog URL never retargets an installed repair: the durable record endpoint wins", async () => {
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://old.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://old.acme.test/mcp"));
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			service: serviceFixture({ transport: { type: "http", url: "https://new.acme.test/mcp" } }),
			record: store.get("acme"),
			credential: authStorage.get(mcpCredentialKey("acme")),
		});
		expect(eligibility.allowed).toBe(true);
		expect(eligibility.repair).toBe(true);
		expect(eligibility.endpoint).toBe("https://old.acme.test/mcp");
	});

	it("a pending reservation shell alone is not repair evidence for a vanished-source service", async () => {
		await store.reserveConnectionId({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://old.acme.test/mcp",
			label: "Acme",
			status: "pending",
			attemptId: "shell",
			createdAt: 1,
			updatedAt: 1,
		});
		await store.releaseClaim({ connectionId: "acme", attemptId: "shell" });
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			service: serviceFixture({
				transport: { type: "http", url: "https://old.acme.test/mcp" },
				pinnedFromRecord: true,
			}),
			record: store.get("acme"),
			credential: undefined,
		});
		expect(eligibility.allowed).toBe(false);
		expect(eligibility.setupHint).toContain("remove this account or restore its source");
	});

	it("a credential-only exact-id bound grant qualifies for repair at its bound endpoint", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://old.acme.test/mcp"));
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			service: serviceFixture({ transport: { type: "http", url: "https://new.acme.test/mcp" } }),
			record: undefined,
			credential: authStorage.get(mcpCredentialKey("acme")),
		});
		expect(eligibility).toMatchObject({ allowed: true, repair: true, endpoint: "https://old.acme.test/mcp" });
	});

	it("an active attempt denies every login route on that account", async () => {
		await store.reserveConnectionId({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "pending",
			attemptId: "live",
			createdAt: 1,
			updatedAt: 1,
		});
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			service: serviceFixture(),
			record: store.get("acme"),
			credential: undefined,
		});
		expect(eligibility.allowed).toBe(false);
		expect(eligibility.setupHint).toContain("Login in progress");
	});

	it("explicit login commands carry OAuth intent; picker fresh Connect keeps the stricter settings check", () => {
		const config: McpServerConfig = { type: "http", url: "https://mcp.acme.test/mcp" };
		const strict = mcpLoginEligibility({
			connectionId: "acme",
			userConfig: config,
			record: undefined,
			credential: undefined,
		});
		expect(strict.allowed).toBe(false);
		const explicit = mcpLoginEligibility({
			connectionId: "acme",
			userConfig: config,
			record: undefined,
			credential: undefined,
			explicitLogin: true,
		});
		expect(explicit).toMatchObject({ allowed: true, endpoint: "https://mcp.acme.test/mcp" });
	});

	it("bearer-token settings servers never take the OAuth login route", () => {
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			userConfig: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true, bearerTokenEnvVar: "ACME_TOKEN" },
			record: undefined,
			credential: undefined,
			explicitLogin: true,
		});
		expect(eligibility.allowed).toBe(false);
		expect(eligibility.setupHint).toContain("settings-managed authentication");
	});

	it("unverified imported OAuth candidates stay explicitly connectable without a tested/certified claim", () => {
		const service = serviceFixture({ metadataReviewed: false });
		const eligibility = mcpLoginEligibility({
			connectionId: "acme",
			service,
			record: undefined,
			credential: undefined,
		});
		expect(eligibility).toMatchObject({ allowed: true, endpoint: "https://mcp.acme.test/mcp" });
		expect(eligibility.repair).toBeUndefined();
	});
});

describe("ENG-6108 catalog ordering and OAuth identity resolution", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-order-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("orders connected and ready-to-connect services first without hiding any row", () => {
		const now = Date.now();
		const connectedRecord: McpConnectionRecord = {
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: now,
			toolCount: 1,
			createdAt: now,
			updatedAt: now,
		};
		store.upsert(connectedRecord);
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
		const views = buildPluginViews({
			services: [
				serviceFixture({ serviceId: "zeta", label: "Zeta", setup: { status: "requires-setup" } }),
				serviceFixture({ serviceId: "acme", label: "Acme" }),
				serviceFixture({ serviceId: "beta", label: "Beta" }),
			],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views.map((view) => view.serviceId)).toEqual(["acme", "beta", "zeta"]);
		expect(views.every((view) => ["acme", "beta", "zeta"].includes(view.serviceId))).toBe(true);
	});

	it("resolves a configured OAuth client identity with fail-closed secret semantics", () => {
		const previous = process.env.ACME_OAUTH_SECRET;
		process.env.ACME_OAUTH_SECRET = "configured-secret";
		try {
			const identity = resolveMcpOAuthIdentity({
				type: "http",
				url: "https://mcp.acme.test/mcp",
				oauth: true,
				oauthClientId: "my-client",
				oauthClientSecretEnvVar: "ACME_OAUTH_SECRET",
				oauthClientMetadataUrl: "https://mcp.acme.test/.well-known/oauth-client",
				oauthScopes: ["read", "write"],
			});
			expect(identity).toEqual({
				clientId: "my-client",
				clientSecret: "configured-secret",
				clientMetadataUrl: "https://mcp.acme.test/.well-known/oauth-client",
				scopes: ["read", "write"],
			});
		} finally {
			if (previous === undefined) delete process.env.ACME_OAUTH_SECRET;
			else process.env.ACME_OAUTH_SECRET = previous;
		}
	});

	it("a configured secret env that is missing resolves to the explicit empty string, never a stale fallback", () => {
		const identity = resolveMcpOAuthIdentity({
			type: "http",
			url: "https://mcp.acme.test/mcp",
			oauth: true,
			oauthClientSecretEnvVar: "ACME_MISSING_SECRET",
		});
		expect(identity.clientSecret).toBe("");
	});

	it("identity stays empty for configs without OAuth fields or non-HTTP transports", () => {
		expect(resolveMcpOAuthIdentity({ type: "http", url: "https://mcp.acme.test/mcp" })).toEqual({});
		expect(resolveMcpOAuthIdentity(undefined)).toEqual({});
		expect(
			resolveMcpOAuthIdentity({
				type: "http",
				url: "https://mcp.acme.test/mcp",
				oauthScopes: [],
			}),
		).toEqual({});
	});
});

describe("verifyMcpConnection", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-verify-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		resetOAuthProviders();
		// Production registers the catalog OAuth provider before login, so
		// authStorage.getApiKey resolves the stored grant.
		registerOAuthProvider(
			createMcpOAuthProvider({ server: "acme", label: "Acme", url: "https://mcp.acme.test/mcp" }),
		);
		authStorage.set(mcpCredentialKey("acme"), {
			type: "oauth",
			access: "grant-a",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("records connected with the discovered tool count after a successful handshake", async () => {
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => ({ ok: true, toolCount: 5 }),
		});
		expect(record.status).toBe("connected");
		expect(record.toolCount).toBe(5);
		expect(store.get("acme")?.status).toBe("connected");
	});

	it("records error with a fixed safe category when the server rejects the credential", async () => {
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => ({ ok: false, error: MCP_PROBE_ERRORS.UNAUTHORIZED }),
		});
		expect(record.status).toBe("error");
		// The failure is a fixed category; the endpoint URL never leaks into it.
		expect(record.lastError).toBe("http-unauthorized");
		expect(record.lastError).not.toContain("mcp.acme.test");
	});

	it("keeps pending (not error) when verification could not run — a broken probe is not a broken grant", async () => {
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => ({ ok: false, error: MCP_PROBE_ERRORS.NETWORK }),
		});
		expect(record.status).toBe("pending");
		expect(record.lastError).toBe("network-unreachable");
	});

	it("binds verification currency to the exact probed token (equal, different, empty, length)", async () => {
		// Equal: the probed token matches the current grant.
		expect(sameGrantToken("token-a", "token-a")).toBe(true);
		// Different token of equal length: constant-time inequality.
		expect(sameGrantToken("token-a", "token-b")).toBe(false);
		// Empty grants stay current against empty (nothing to rotate).
		expect(sameGrantToken("", "")).toBe(true);
		// A rotated token of a different length must still compare unequal.
		expect(sameGrantToken("short", "a-much-longer-rotated-token")).toBe(false);
		// Replacement of the same length is still detected.
		expect(sameGrantToken("token-a", "token-x")).toBe(false);
	});

	it("discards a stale verify result when the connection is logged out mid-probe", async () => {
		let releaseProbe: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const verifyPromise = verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => {
				await probeGate;
				return { ok: true, toolCount: 4 };
			},
		});
		// Logout lands while the probe is in flight.
		authStorage.logout(mcpCredentialKey("acme"));
		releaseProbe?.();
		const record = await verifyPromise;
		expect(record.status).toBe("pending");
		expect(record.lastError).toBe("credential-changed");
		// The stale result must never persist a connected record.
		expect(store.get("acme")).toBeUndefined();
	});

	it("discards a stale verify result when the grant rotates mid-probe", async () => {
		let releaseProbe: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const verifyPromise = verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => {
				await probeGate;
				return { ok: true, toolCount: 4 };
			},
		});
		// The credential rotates (re-login/refresh) while the probe is in flight.
		authStorage.set(mcpCredentialKey("acme"), {
			type: "oauth",
			access: "grant-b",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		releaseProbe?.();
		const record = await verifyPromise;
		expect(record.status).toBe("pending");
		expect(record.lastError).toBe("credential-changed");
		expect(store.get("acme")?.status).not.toBe("connected");
	});

	it("persists records across store reloads", async () => {
		await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => ({ ok: true, toolCount: 2 }),
		});
		const reopened = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		expect(reopened.get("acme")?.status).toBe("connected");
	});

	it("tolerates a corrupt connections file by resetting", () => {
		writeFileSync(join(tempDir, "mcp-connections.json"), "{ not json", "utf8");
		const reopened = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		expect(reopened.records()).toEqual([]);
	});
});

describe("defaultServiceCatalogProvider", () => {
	it("derives descriptors from the merged catalog: legacy built-ins plus the imported entries", () => {
		const services = defaultServiceCatalogProvider()();
		const ids = new Set(services.map((service) => service.serviceId));
		// The merged catalog supersedes the legacy-only slice; the full entry set
		// (140 today) still contains the reserved legacy built-ins.
		expect(ids.has("linear")).toBe(true);
		expect(ids.has("notion")).toBe(true);
		expect(services.length).toBeGreaterThan(100);
		const legacy = services.filter((service) => service.legacyBuiltin);
		expect(legacy.map((service) => service.serviceId).sort()).toEqual(["linear", "notion"]);
		// Imported entries are never reviewed by construction.
		for (const service of services) {
			if (!service.legacyBuiltin) {
				expect(service.metadataReviewed).toBe(false);
			}
		}
	});
});

describe("nextMcpConnectionId", () => {
	it("keeps the service id for the first account and allocates -2, -3, ... after it", () => {
		const taken = new Set<string>(["acme", "acme-2"]);
		expect(nextMcpConnectionId("acme", (id) => taken.has(id))).toBe("acme-3");
		taken.delete("acme");
		expect(nextMcpConnectionId("acme", (id) => taken.has(id))).toBe("acme");
		taken.add("acme");
		taken.add("acme-3");
		expect(nextMcpConnectionId("acme", (id) => taken.has(id))).toBe("acme-4");
	});
});

describe("ENG-6108 computed per-account status (no stale Connected)", () => {
	const URL = "https://mcp.acme.test/mcp";
	function build(authStorage: AuthStorage, store: McpConnectionStore) {
		return buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
	}
	function connectedRecord(connectionId: string, at: number) {
		return {
			connectionId,
			serviceId: "acme",
			endpoint: URL,
			label: connectionId === "acme" ? "Acme" : `Acme (${connectionId})`,
			status: "connected" as const,
			verifiedAt: at,
			toolCount: 2,
			createdAt: at,
			updatedAt: at,
		};
	}

	for (const connectionId of ["acme", "acme-2"]) {
		it(`a previously connected record with an UNBOUND credential reports Reconnect, not Connected (${connectionId})`, () => {
			const authStorage = AuthStorage.inMemory();
			authStorage.set(mcpCredentialKey(connectionId), {
				type: "oauth",
				access: "tok",
				refresh: "r",
				expires: Date.now() + 3600_000,
			});
			const store = McpConnectionStore.open(join(tmpdir(), `stale-unbound-${connectionId}/mcp-connections.json`));
			store.upsert(connectedRecord(connectionId, Date.now()));
			const views = build(authStorage, store);
			expect(views[0]?.connectionStatus).toBe("error");
			expect(views[0]?.setupHint).toContain("Reconnect required");
			// The inventory row agrees (same computed status).
			const connections = buildConnectionViews({
				services: [serviceFixture()],
				userServers: undefined,
				authStorage,
				connectionStore: store,
			});
			expect(connections.find((connection) => connection.connectionId === connectionId)?.status).toBe("error");
		});

		it(`a previously connected record with a RETARGETED credential reports Reconnect (${connectionId})`, () => {
			const authStorage = AuthStorage.inMemory();
			authStorage.set(mcpCredentialKey(connectionId), {
				type: "oauth",
				access: "tok",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://retargeted.test/mcp",
			});
			const store = McpConnectionStore.open(join(tmpdir(), `stale-retarget-${connectionId}/mcp-connections.json`));
			store.upsert(connectedRecord(connectionId, Date.now()));
			const views = build(authStorage, store);
			expect(views[0]?.connectionStatus).toBe("error");
			expect(views[0]?.setupHint).toContain("Reconnect required");
		});

		it(`a previously connected record with an EXPIRED, no-refresh credential reports Reconnect (${connectionId})`, () => {
			const authStorage = AuthStorage.inMemory();
			authStorage.set(mcpCredentialKey(connectionId), {
				type: "oauth",
				access: "tok",
				// Empty refresh token: expired AND unrecoverable.
				refresh: "",
				expires: Date.now() - 60_000,
				endpoint: URL,
			});
			const store = McpConnectionStore.open(join(tmpdir(), `stale-expired-${connectionId}/mcp-connections.json`));
			store.upsert(connectedRecord(connectionId, Date.now()));
			const views = build(authStorage, store);
			expect(views[0]?.connectionStatus).toBe("error");
			expect(views[0]?.setupHint).toContain("expired without a refresh token");
		});
	}

	it("catalog metadata aliases are searchable when absent from label, id, and description", () => {
		const service = serviceFixture({
			label: "Totally Different Name",
			aliases: ["linear-app", "lnr"],
		});
		const views = buildPluginViews({
			services: [service],
			userServers: undefined,
			authStorage: AuthStorage.inMemory(),
			connectionStore: McpConnectionStore.open(join(tmpdir(), "alias-search/mcp-connections.json")),
		});
		expect(views[0]?.aliases).toEqual(["linear-app", "lnr"]);
		// The alias hits nowhere else on the card.
		expect(views[0]?.label).not.toContain("linear-app");
		expect(views[0]?.serviceId).not.toContain("linear-app");
		expect(views[0]?.description ?? "").not.toContain("linear-app");
		// But it matches the search.
		expect(searchPluginViews(views, "linear-app", 10)).toHaveLength(1);
		expect(searchPluginViews(views, "lnr", 10)).toHaveLength(1);
		expect(searchPluginViews(views, "no-such-thing", 10)).toHaveLength(0);
	});
});

describe("ENG-6108 wave-4 resolver and account aggregation", () => {
	function accountRecord(connectionId: string, status: "connected" | "pending" | "error", at: number) {
		return {
			connectionId,
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status,
			createdAt: at,
			updatedAt: at,
		};
	}

	it("a failing local source never blocks the rest: built-ins and other sources survive with a visible diagnostic", () => {
		const resolution = resolveMcpServiceCatalog({
			localSources: ["/bad.json", "/good.json"],
			loadLocal: (filePath: string) => {
				if (filePath === "/bad.json") {
					throw new Error("Unexpected token in JSON");
				}
				return {
					entries: [
						{
							server: "goodlocal",
							service: "goodlocal",
							label: "Good Local",
							url: "https://good.test/mcp",
							aliases: [],
							transport: { type: "http", url: "https://good.test/mcp" },
							auth: { strategy: "oauth", clientRegistration: "dynamic" },
							setup: { status: "ready" },
							verification: { status: "unverified" },
							legacyBuiltin: false,
							provenance: [],
						} as McpServiceEntry,
					],
					path: filePath,
				};
			},
		});
		expect(resolution.descriptors.some((service) => service.serviceId === "linear")).toBe(true);
		expect(resolution.descriptors.some((service) => service.serviceId === "goodlocal")).toBe(true);
		expect(resolution.diagnostics.some((line) => line.includes("/bad.json") && line.includes("failed to load"))).toBe(
			true,
		);
	});

	it("an installed connection whose source vanished keeps a pinned descriptor at the record's endpoint", () => {
		const at = Date.now();
		const resolution = resolveMcpServiceCatalog({
			localSources: [],
			records: [
				{
					connectionId: "vanishsvc",
					serviceId: "vanishsvc",
					endpoint: "https://mcp.acme.test/mcp",
					label: "Vanished",
					status: "connected",
					createdAt: at,
					updatedAt: at,
				},
			],
		});
		const pinned = resolution.descriptors.find((service) => service.serviceId === "vanishsvc");
		expect(pinned).toMatchObject({
			pinnedFromRecord: true,
			transport: { type: "http", url: "https://mcp.acme.test/mcp" },
		});
		// Pinned-from-record is its own trust path: never user-placed trust.
		expect(pinned?.localSource ?? false).toBe(false);
		expect(pinned?.authStrategy).toBe("oauth");
		// The pinned endpoint keeps the credential usable (binding preserved).
		const authStorage = AuthStorage.inMemory();
		authStorage.set(mcpCredentialKey("vanishsvc"), {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const store = McpConnectionStore.open(join(tmpdir(), `svc-pin-${at}/mcp-connections.json`));
		store.upsert({
			connectionId: "vanishsvc",
			serviceId: "vanishsvc",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Vanished",
			status: "connected",
			createdAt: at,
			updatedAt: at,
		});
		const views = buildPluginViews({
			services: [pinned ?? { ...serviceFixture(), serviceId: "vanishsvc" }],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("connected");
		expect(views[0]?.connectionIds).toEqual(["vanishsvc"]);
		expect(views[0]?.setupHint).toContain("catalog source is unavailable");
	});

	it("aggregates accounts: primary connected + alias pending stays connected and lists BOTH account ids", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(mcpCredentialKey("acme"), {
			type: "oauth",
			access: "primary",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		authStorage.set(mcpCredentialKey("acme-2"), {
			type: "oauth",
			access: "second",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const store = McpConnectionStore.open(join(tmpdir(), "svc-agg/mcp-connections.json"));
		const at = Date.now();
		store.upsert({ ...accountRecord("acme", "connected", at), verifiedAt: at, toolCount: 4 });
		store.upsert(accountRecord("acme-2", "pending", at));
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("connected");
		expect(views[0]?.connectionIds).toEqual(["acme", "acme-2"]);
	});

	it("after the default account disconnects, the remaining alias stays visible and manageable", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set(mcpCredentialKey("acme-2"), {
			type: "oauth",
			access: "second",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const store = McpConnectionStore.open(join(tmpdir(), "svc-alias-left/mcp-connections.json"));
		const at = Date.now();
		store.remove("acme");
		store.upsert(accountRecord("acme-2", "pending", at));
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		// The service card survives via the alias account, never vanishing.
		expect(views).toHaveLength(1);
		expect(views[0]?.connectionIds).toEqual(["acme-2"]);
		// The alias is searchable by its account id.
		expect(searchPluginViews(views, "acme-2", 10)).toHaveLength(1);
		// The connection inventory lists the alias with its own status.
		const connections = buildConnectionViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(connections.map((connection) => connection.connectionId)).toEqual(["acme-2"]);
	});

	it("an alias whose credential went missing is listed as reconnect-required, not silently dropped", () => {
		const store = McpConnectionStore.open(join(tmpdir(), "svc-alias-stale/mcp-connections.json"));
		const at = Date.now();
		store.upsert(accountRecord("acme-2", "connected", at));
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage: AuthStorage.inMemory(),
			connectionStore: store,
		});
		expect(views[0]?.connectionIds).toContain("acme-2");
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("Reconnect required");
	});
});

describe("resolveMcpServiceCatalog", () => {
	function bundledEntry(overrides: Record<string, unknown> = {}): McpServiceEntry {
		return {
			server: "brand",
			service: "brand",
			label: "Brand",
			url: "https://brand.test/mcp",
			aliases: ["brandapp"],
			transport: { type: "http", url: "https://brand.test/mcp" },
			auth: { strategy: "oauth", clientRegistration: "dynamic" },
			setup: { status: "ready" },
			verification: { status: "metadata-reviewed" },
			legacyBuiltin: false,
			...overrides,
		} as McpServiceEntry;
	}

	function viewsFor(service: McpServiceDescriptor): McpPluginView[] {
		return buildPluginViews({
			services: [service],
			userServers: undefined,
			authStorage: AuthStorage.inMemory(),
			connectionStore: McpConnectionStore.open(join(tmpdir(), `svc-resolver-${Date.now()}/mcp-connections.json`)),
		});
	}

	it("maps the bundled catalog: metadata-reviewed OAuth entries stay one-click connectable", () => {
		const resolution = resolveMcpServiceCatalog({ localSources: [] });
		const linear = resolution.descriptors.find((service) => service.serviceId === "linear");
		expect(linear).toMatchObject({
			metadataReviewed: true,
			legacyBuiltin: true,
			authStrategy: "oauth",
		});
		if (linear) {
			const views = viewsFor(linear);
			expect(views[0]?.connectable).toBe(true);
			expect(views[0]?.unverified ?? false).toBe(false);
		}
	});

	it("keeps unverified OAuth candidates visible and explicitly connectable", () => {
		const resolution = resolveMcpServiceCatalog({ localSources: [] });
		// A real bundled import: unverified by construction, OAuth, ready, http.
		const imported = resolution.descriptors.find(
			(service) =>
				!service.legacyBuiltin &&
				!service.metadataReviewed &&
				service.authStrategy === "oauth" &&
				service.setup.status === "ready" &&
				service.transport.type === "http",
		);
		expect(imported).toBeDefined();
		if (imported) {
			const views = viewsFor(imported);
			expect(views[0]?.connectable).toBe(true);
			expect(views[0]?.setupHint).toContain("not been verified");
		}
	});

	it("loads declared local sources after the built-ins with ~ expansion", () => {
		const resolution = resolveMcpServiceCatalog({
			localSources: ["~/local-services.json"],
			loadLocal: (filePath: string) => {
				expect(filePath).toBe(join(homedir(), "local-services.json"));
				return {
					entries: [
						bundledEntry({
							server: "mylocal",
							verification: { status: "unverified" },
						}),
					],
					path: filePath,
				};
			},
		});
		const local = resolution.descriptors.find((service) => service.serviceId === "mylocal");
		expect(local?.localSource).toBe(true);
		expect(local?.metadataReviewed).toBe(false);
		// Trusted local entries connect through the login dialog's explicit approval.
		if (local) {
			const views = viewsFor(local);
			expect(views[0]?.connectable).toBe(true);
		}
	});

	it("surfaces declared-but-missing sources and duplicate ids as visible diagnostics", () => {
		const resolution = resolveMcpServiceCatalog({
			localSources: ["/missing/services.json", "/dup/a.json", "/dup/b.json"],
			loadLocal: (filePath: string) => {
				if (filePath === "/missing/services.json") return { entries: [], path: "" };
				return { entries: [bundledEntry({ server: "dupe" })], path: filePath };
			},
		});
		expect(resolution.diagnostics.some((line) => line.includes("not found: /missing/services.json"))).toBe(true);
		expect(resolution.diagnostics.some((line) => line.includes('"dupe"'))).toBe(true);
		expect(resolution.descriptors.filter((service) => service.serviceId === "dupe")).toHaveLength(1);
	});

	it("enforces a total cap with a visible diagnostic", () => {
		const huge: McpServiceEntry[] = Array.from({ length: 600 }, (_, index) =>
			bundledEntry({ server: `bulk-${index}` }),
		);
		const capped = resolveMcpServiceCatalog({
			localSources: ["/huge.json"],
			loadLocal: () => ({ entries: huge, path: "/huge.json" }),
		});
		expect(capped.descriptors).toHaveLength(500);
		expect(capped.diagnostics.some((line) => line.includes("capped at 500"))).toBe(true);
	});
	it("retains EVERY installed serviceId under cap pressure, in-source or pinned", () => {
		const huge: McpServiceEntry[] = Array.from({ length: 600 }, (_, index) =>
			bundledEntry({ server: `bulk-${index}` }),
		);
		const now = Date.now();
		const records = [
			{
				connectionId: "bulk-550",
				serviceId: "bulk-550",
				endpoint: "https://bulk-550.example/mcp",
				label: "In-Source",
				status: "connected",
				createdAt: now,
				updatedAt: now,
			},
			{
				connectionId: "pinned-svc",
				serviceId: "pinned-svc",
				endpoint: "https://pinned.example/mcp",
				label: "Vanished Source",
				status: "connected",
				createdAt: now,
				updatedAt: now,
			},
		] satisfies Array<McpConnectionRecord>;
		const capped = resolveMcpServiceCatalog({
			localSources: ["/huge.json"],
			loadLocal: () => ({ entries: huge, path: "/huge.json" }),
			records,
		});
		// The cap still binds (500), but BOTH installed serviceIds survive —
		// the in-source one is retained instead of sliced away, the vanished-
		// source pin is never the first thing discarded, and legacy builtins
		// keep their reserved names.
		expect(capped.descriptors).toHaveLength(500);
		const kept = new Set(capped.descriptors.map((descriptor) => descriptor.serviceId));
		expect(kept.has("bulk-550")).toBe(true);
		expect(kept.has("pinned-svc")).toBe(true);
		expect(kept.has("linear")).toBe(true);
		expect(kept.has("notion")).toBe(true);
		expect(capped.diagnostics.some((line) => line.includes("discovery capped at 500"))).toBe(true);
		expect(
			capped.diagnostics.some((line) =>
				line.includes("Installed connections and built-in services are always kept"),
			),
		).toBe(true);
	});

	it("keeps an installed inventory that ALONE exceeds the cap, with an explicit diagnostic", () => {
		const huge: McpServiceEntry[] = Array.from({ length: 50 }, (_, index) =>
			bundledEntry({ server: `bulk-${index}` }),
		);
		const now = Date.now();
		const records = Array.from({ length: 510 }, (_, index) => ({
			connectionId: `installed-${index}`,
			serviceId: `installed-${index}`,
			endpoint: "https://installed.example/mcp",
			label: `Installed ${index}`,
			status: "connected" as const,
			createdAt: now,
			updatedAt: now,
		}));
		const capped = resolveMcpServiceCatalog({
			localSources: ["/huge.json"],
			loadLocal: () => ({ entries: huge, path: "/huge.json" }),
			records,
		});
		// Manageability never drops: all 510 installed serviceIds AND the
		// legacy builtins are kept even though the retained inventory alone
		// exceeds the cap, the diagnostic says so explicitly, and only
		// uninstalled candidates were trimmed.
		const kept = capped.descriptors.map((descriptor) => descriptor.serviceId);
		expect(kept.filter((id) => id.startsWith("installed-"))).toHaveLength(510);
		expect(kept).toContain("linear");
		expect(kept).toContain("notion");
		expect(kept.filter((id) => id.startsWith("bulk-"))).toEqual([]);
		expect(capped.diagnostics.some((line) => line.includes("retained inventory alone exceeded the cap"))).toBe(true);
	});
});
