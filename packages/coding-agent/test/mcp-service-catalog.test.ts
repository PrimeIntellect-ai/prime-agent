import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import {
	buildConnectionViews,
	buildPluginViews,
	decodePluginCursor,
	defaultServiceCatalogProvider,
	filterPluginViewsByStatus,
	type McpServiceDescriptor,
	mcpCredentialKey,
	pagePluginViews,
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
		catalogVerified: true,
		bundledSkill: false,
		...overrides,
	};
}

function oauthCredential(expiresInMs = 3600_000) {
	return { type: "oauth" as const, access: "tok", refresh: "r", expires: Date.now() + expiresInMs };
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

	it("never reports connected from a stored token alone: legacy grants stay pending", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
		const views = buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("pending");
		expect(views[0]?.connectionIds).toEqual(["acme"]);
	});

	it("reports connected only with a verified connection record", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
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
		expect(views[0]?.connectionIds).toEqual([]);
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

	it("marks imported, unvetted catalog entries as unverified while staying connectable", () => {
		const views = buildPluginViews({
			services: [serviceFixture({ catalogVerified: false })],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.unverified).toBe(true);
		expect(views[0]?.connectable).toBe(true);
	});

	it("keeps user-declared servers working when the catalog adds the same id (user owns non-bundled ids)", () => {
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
			services: [serviceFixture({ serviceId: "notion", label: "Notion", bundledSkill: true })],
			userServers,
			authStorage,
			connectionStore: store,
		});
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({ source: "catalog", serviceId: "notion" });
	});

	it("builds connection views including pending and user servers, sorted by connectionId", () => {
		authStorage.set(mcpCredentialKey("acme"), oauthCredential());
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
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
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

	it("records error when the server rejects the credential", async () => {
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe: async () => ({ ok: false, error: "MCP verification at https://mcp.acme.test/mcp failed: HTTP 401" }),
		});
		expect(record.status).toBe("error");
		expect(record.lastError).toContain("401");
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
			probe: async () => ({ ok: false, error: "MCP verification failed: request failed" }),
		});
		expect(record.status).toBe("pending");
		expect(record.lastError).toContain("request failed");
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
	it("derives descriptors from the built-in catalog with linear and notion", () => {
		const services = defaultServiceCatalogProvider()();
		const ids = services.map((service) => service.serviceId).sort();
		expect(ids).toEqual(["linear", "notion"]);
		for (const service of services) {
			expect(service.transport.type).toBe("http");
			expect(service.bundledSkill).toBe(true);
		}
	});
});
