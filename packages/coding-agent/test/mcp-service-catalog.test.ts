import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServiceEntry } from "@earendil-works/pi-ai/mcp";
import { createMcpOAuthProvider } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { MCP_PROBE_ERRORS } from "../src/core/mcp/connection-probe.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import {
	buildConnectionViews,
	buildPluginViews,
	decodePluginCursor,
	defaultServiceCatalogProvider,
	filterPluginViewsByStatus,
	type McpPluginView,
	type McpServiceDescriptor,
	mcpCredentialKey,
	nextMcpConnectionId,
	pagePluginViews,
	resolveMcpServiceCatalog,
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

	it("marks imported, metadata-unreviewed catalog entries as candidates: unverified, never one-click connectable", () => {
		const views = buildPluginViews({
			services: [serviceFixture({ metadataReviewed: false })],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.unverified).toBe(true);
		expect(views[0]?.connectable).toBe(false);
		expect(views[0]?.setupHint).toContain("not been reviewed");
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

	it("keeps unreviewed imported OAuth entries as candidates — no one-click Connect", () => {
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
			expect(views[0]?.connectable).toBe(false);
			expect(views[0]?.setupHint).toContain("not been reviewed");
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
});
