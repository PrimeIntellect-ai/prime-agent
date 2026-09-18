import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServiceEntry } from "@earendil-works/pi-ai/mcp";
import { createMcpOAuthProvider, SERVICE_CATALOG } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type McpStaticTokenCredential } from "../src/core/auth-storage.js";
import { MCP_PROBE_ERRORS } from "../src/core/mcp/connection-probe.js";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import {
	buildConnectionViews,
	buildPluginViews,
	defaultServiceCatalogProvider,
	isPasteableTokenService,
	type McpPluginView,
	type McpServiceDescriptor,
	mcpCredentialFieldPromptLabel,
	mcpCredentialFields,
	mcpCredentialKey,
	mcpLoginEligibility,
	mcpPasteCredential,
	mcpStaticTokenUsable,
	nextMcpConnectionId,
	resolveMcpOAuthIdentity,
	resolveMcpServiceCatalog,
	sameGrantToken,
	searchPluginViews,
	verifyMcpConnection,
} from "../src/core/mcp/service-catalog.js";

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

	/** The view surface under test: one catalog service over the live stores. */
	function buildViews(): McpPluginView[] {
		return buildPluginViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
	}

	it("lists a catalog service as not connected and connectable without credentials", () => {
		const views = buildViews();
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
		const views = buildViews();
		expect(views[0]?.connectionStatus).toBe("pending");
		expect(views[0]?.connectionIds).toEqual(["acme"]);
	});

	it.each([
		{ name: "an unbound legacy grant", credential: () => oauthCredential() },
		{ name: "a cross-endpoint grant", credential: () => oauthCredential(3600_000, "https://other.example/mcp") },
	])("surfaces $name as reconnect-required, never pending or connected", ({ credential }) => {
		authStorage.set(mcpCredentialKey("acme"), credential());
		const views = buildViews();
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
		const views = buildViews();
		expect(views[0]?.connectionStatus).toBe("connected");
		expect(views[0]?.toolCount).toBe(7);
		expect(views[0]?.verifiedAt).toBeGreaterThan(0);
	});

	// Wrong-type and empty-access grant usability is pinned across predicate,
	// prompt, dispatch, and view in mcp-catalog-eligibility.test.ts.

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
		const views = buildViews();
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("Reconnect");
	});

	// Expired-no-refresh status and its honest hint are pinned across
	// predicate, prompt, dispatch, and view in mcp-catalog-eligibility.test.ts.

	// none+requires-setup failing closed with no connect action is pinned across prompt, dispatch, and view in
	// mcp-catalog-eligibility.test.ts ("%s across prompt and dispatch").

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

	// Unverified imported OAuth candidates staying explicitly connectable is pinned in this file's
	// resolveMcpServiceCatalog describe ("keeps unverified OAuth candidates visible and explicitly connectable").

	// User-owned non-legacy ids coexisting with catalog rows is pinned at dispatch level in mcp-manager.test.ts ("serves
	// custom catalog providers: user-owned non-bundled ids coexist with catalog cards").

	// Dead user shadows of bundled catalog ids are pinned with the reserved name matrix at dispatch level in
	// mcp-manager.test.ts ("ENG-6108 reserved ownership and durable repair endpoints").

	// Plugin/connection listing, search, strict status filtering, and honest cursor pagination are pinned at the
	// PROTOCOL boundary (the mcp.list_plugins / mcp.search_plugins handlers) in mcp-manager.test.ts.
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

	// A claimed account being live ownership (no second action, Remove stays
	// available) is pinned at dispatch level in mcp-manager.test.ts
	// ("background verification never probes an account claimed by a live
	// attempt") and at the chain seam in service-catalog-picker.test.ts
	// ("a blocked action (login in progress) reports its status and never re-enters").
});

// Reserved-builtin ownership classification (canonical-equivalent keeps the slot live, enabled:false disables without
// deleting, conflicting names never dispatch, installed accounts stay listed) is pinned at the DISPATCH level in
// mcp-manager.test.ts ("ENG-6108 reserved ownership and durable repair endpoints") and
// mcp-catalog-eligibility.test.ts.

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

	// Login intent routing (explicit commands carry OAuth intent; the guarded claim runs it) is pinned at the mode seam
	// in mcp-activation-queue.test.ts and at dispatch level in mcp-manager.test.ts.

	// Bearer-token settings servers staying token-based (never OAuth) is pinned in mcp-catalog-eligibility.test.ts ("a
	// configured bearer env var is the ONLY credential source") and at dispatch level in mcp-manager.test.ts.

	// Unverified candidates staying explicitly connectable (no tested or certified claim) is pinned in the
	// resolveMcpServiceCatalog describe in this file ("keeps unverified OAuth candidates visible and explicitly
	// connectable").
});

describe("ENG-6108 catalog ordering and OAuth identity resolution", () => {
	let tempDir: string;
	let _authStorage: AuthStorage;
	let _store: McpConnectionStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-order-"));
		_authStorage = AuthStorage.inMemory();
		_store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Catalog row ordering (connected and ready-to-connect first) is pinned
	// at the protocol boundary in mcp-manager.test.ts ("lists enabled generic
	// servers including connected catalog services in deterministic order").

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
		// Production registers the catalog OAuth provider before login, so authStorage.getApiKey resolves the stored grant.
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

	/** The shared verify options over the live stores, with an injected probe. */
	function verify(probe: NonNullable<Parameters<typeof verifyMcpConnection>[0]["probe"]>) {
		return verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "acme",
			serviceId: "acme",
			label: "Acme",
			endpoint: "https://mcp.acme.test/mcp",
			usesOAuth: true,
			probe,
		});
	}

	it("records connected with the discovered tool count after a successful handshake", async () => {
		const record = await verify(async () => ({ ok: true, toolCount: 5 }));
		expect(record.status).toBe("connected");
		expect(record.toolCount).toBe(5);
		expect(store.get("acme")?.status).toBe("connected");
	});

	it("records error with a fixed safe category when the server rejects the credential", async () => {
		const record = await verify(async () => ({ ok: false, error: MCP_PROBE_ERRORS.UNAUTHORIZED }));
		expect(record.status).toBe("error");
		// The failure is a fixed category; the endpoint URL never leaks into it.
		expect(record.lastError).toBe("http-unauthorized");
		expect(record.lastError).not.toContain("mcp.acme.test");
	});

	it("keeps pending (not error) when verification could not run — a broken probe is not a broken grant", async () => {
		const record = await verify(async () => ({ ok: false, error: MCP_PROBE_ERRORS.NETWORK }));
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
		const verifyPromise = verify(async () => {
			await probeGate;
			return { ok: true, toolCount: 4 };
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
		const verifyPromise = verify(async () => {
			await probeGate;
			return { ok: true, toolCount: 4 };
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
		await verify(async () => ({ ok: true, toolCount: 2 }));
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
		// The merged catalog supersedes the legacy-only slice; the full entry set (70 today, after the 2026-09-14 zero-app
		// cut, the 2026-09-15 final cut to one-click DCR or user token/key only, and the 2026-09-16 token-only cut) still
		// contains the reserved legacy built-ins.
		expect(ids.has("linear")).toBe(true);
		expect(ids.has("notion")).toBe(true);
		expect(services.length).toBeGreaterThan(50);
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

	// The per-account path (the "-2" alias id) shares the computed-status rule: a previously CONNECTED record with a
	// broken credential never reads as Connected. One table covers the three broken-credential states; the inventory row
	// agrees with the card (same computed status).
	const connectionId = "acme-2";
	it.each([
		{
			name: "UNBOUND",
			credential: () => ({ type: "oauth" as const, access: "tok", refresh: "r", expires: Date.now() + 3600_000 }),
			hint: "Reconnect required",
			checkInventory: true,
		},
		{
			name: "RETARGETED",
			credential: () => ({
				type: "oauth" as const,
				access: "tok",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://retargeted.test/mcp",
			}),
			hint: "Reconnect required",
			checkInventory: false,
		},
		{
			name: "EXPIRED, no-refresh",
			credential: () => ({
				type: "oauth" as const,
				access: "tok",
				// Empty refresh token: expired AND unrecoverable.
				refresh: "",
				expires: Date.now() - 60_000,
				endpoint: URL,
			}),
			hint: "expired without a refresh token",
			checkInventory: false,
		},
	])(
		`a previously connected record with an ${"$"}{name} credential reports Reconnect (${"$"}{connectionId})`,
		({ credential, hint, checkInventory }) => {
			const authStorage = AuthStorage.inMemory();
			authStorage.set(mcpCredentialKey(connectionId), credential());
			const store = McpConnectionStore.open(join(tmpdir(), `stale-${hint}/mcp-connections.json`));
			store.upsert(connectedRecord(connectionId, Date.now()));
			const views = build(authStorage, store);
			expect(views[0]?.connectionStatus).toBe("error");
			expect(views[0]?.setupHint).toContain(hint);
			if (checkInventory) {
				const connections = buildConnectionViews({
					services: [serviceFixture()],
					userServers: undefined,
					authStorage,
					connectionStore: store,
				});
				expect(connections.find((connection) => connection.connectionId === connectionId)?.status).toBe("error");
			}
		},
	);

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

	it("aggregates per-account state: primary+alias, alias-only after a disconnect, and a stale alias", () => {
		// The service card aggregates ALL its accounts: a connected primary keeps the service
		// connected while an alias stays visible; after the primary's record is removed the alias
		// keeps the card alive (still listed and searchable); an alias whose credential went missing
		// surfaces reconnect-required instead of being silently dropped.
		const viewsFor = (store: McpConnectionStore, authStorage: AuthStorage) =>
			buildPluginViews({
				services: [serviceFixture()],
				userServers: undefined,
				authStorage,
				connectionStore: store,
			});

		const primaryAuth = AuthStorage.inMemory();
		primaryAuth.set(mcpCredentialKey("acme"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		primaryAuth.set(mcpCredentialKey("acme-2"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		const at = Date.now();
		const bothStore = McpConnectionStore.open(join(tmpdir(), "svc-agg/mcp-connections.json"));
		bothStore.upsert({ ...accountRecord("acme", "connected", at), verifiedAt: at, toolCount: 4 });
		bothStore.upsert(accountRecord("acme-2", "pending", at));
		const both = viewsFor(bothStore, primaryAuth);
		expect(both[0]?.connectionStatus).toBe("connected");
		expect(both[0]?.connectionIds).toEqual(["acme", "acme-2"]);

		const aliasAuth = AuthStorage.inMemory();
		aliasAuth.set(mcpCredentialKey("acme-2"), oauthCredential(3600_000, "https://mcp.acme.test/mcp"));
		const aliasStore = McpConnectionStore.open(join(tmpdir(), "svc-alias-left/mcp-connections.json"));
		aliasStore.remove("acme");
		aliasStore.upsert(accountRecord("acme-2", "pending", at));
		const alias = viewsFor(aliasStore, aliasAuth);
		expect(alias).toHaveLength(1);
		expect(alias[0]?.connectionIds).toEqual(["acme-2"]);
		expect(searchPluginViews(alias, "acme-2", 10)).toHaveLength(1);
		const connections = buildConnectionViews({
			services: [serviceFixture()],
			userServers: undefined,
			authStorage: aliasAuth,
			connectionStore: aliasStore,
		});
		expect(connections.map((connection) => connection.connectionId)).toEqual(["acme-2"]);

		const staleStore = McpConnectionStore.open(join(tmpdir(), "svc-alias-stale/mcp-connections.json"));
		staleStore.upsert(accountRecord("acme-2", "connected", at));
		const stale = viewsFor(staleStore, AuthStorage.inMemory());
		expect(stale[0]?.connectionIds).toContain("acme-2");
		expect(stale[0]?.connectionStatus).toBe("error");
		expect(stale[0]?.setupHint).toContain("Reconnect required");
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
		// The cap still binds (500), but BOTH installed serviceIds survive — the in-source one is retained instead of
		// sliced away, the vanished- source pin is never the first thing discarded, and legacy builtins keep their reserved
		// names.
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
		// Manageability never drops: all 510 installed serviceIds AND the legacy builtins are kept even though the retained
		// inventory alone exceeds the cap, the diagnostic says so explicitly, and only uninstalled candidates were trimmed.
		const kept = capped.descriptors.map((descriptor) => descriptor.serviceId);
		expect(kept.filter((id) => id.startsWith("installed-"))).toHaveLength(510);
		expect(kept).toContain("linear");
		expect(kept).toContain("notion");
		expect(kept.filter((id) => id.startsWith("bulk-"))).toEqual([]);
		expect(capped.diagnostics.some((line) => line.includes("retained inventory alone exceeded the cap"))).toBe(true);
	});
});

describe("/mcp and /plugins picker row counts", () => {
	it("ships exactly 69 catalog services after the single-credential cut plus the pinned Slack entry", () => {
		// The live /mcp picker counter read /77 against the earlier shipped 75: the extra rows are installed
		// connections pinned from records (below), never catalog growth. The 2026-09-16 token-only and
		// single-credential cuts dropped 7 entries; the 2026-09-17 pinned-client decision added Slack back
		// as the one-click published-harness-client entry. Pin the shipped length so silent re-growth is loud.
		expect(SERVICE_CATALOG.length).toBe(69);
	});

	it("counts rows as the shipped catalog plus pinned installed connections — unique, no off-by-N", () => {
		// Kevin's live state: figma and huggingface-skills were cut from the shipped catalog but their connections are
		// installed, so their records pin durable descriptors and the picker legitimately lists 70 + 2 = 72 rows. Every row
		// is unique — the counter matches the rendered list.
		const catalogIds = new Set(SERVICE_CATALOG.map((entry) => entry.server));
		expect(catalogIds.has("figma")).toBe(false);
		expect(catalogIds.has("huggingface-skills")).toBe(false);
		const now = Date.now();
		const tempDir = mkdtempSync(join(tmpdir(), "svc-catalog-count-"));
		const store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		try {
			for (const id of ["figma", "huggingface-skills"]) {
				store.upsert({
					connectionId: id,
					serviceId: id,
					endpoint: `https://${id}.example.test/mcp`,
					label: id,
					status: "pending",
					createdAt: now,
					updatedAt: now,
				});
			}
			const resolution = resolveMcpServiceCatalog({ records: store.records() });
			expect(resolution.diagnostics).toEqual([]);
			expect(resolution.descriptors).toHaveLength(SERVICE_CATALOG.length + 2);
			expect(resolution.descriptors.filter((descriptor) => descriptor.pinnedFromRecord)).toHaveLength(2);
			const views = buildPluginViews({
				services: resolution.descriptors,
				userServers: {},
				authStorage: AuthStorage.inMemory(),
				connectionStore: store,
			});
			expect(views).toHaveLength(SERVICE_CATALOG.length + 2);
			expect(new Set(views.map((view) => view.serviceId)).size).toBe(SERVICE_CATALOG.length + 2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("catalog token services: the paste flow (storage, views, verification)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;

	const GITHUB_URL = "https://api.githubcopilot.com/mcp/";

	function staticToken(overrides: Partial<McpStaticTokenCredential> = {}): McpStaticTokenCredential {
		return {
			type: "mcp_static_token",
			endpoint: GITHUB_URL,
			bearer: "ghp_pasted-token",
			bearerFieldId: "GITHUB_PAT_TOKEN",
			createdAt: Date.now(),
			...overrides,
		};
	}

	/** A service collecting two GENUINELY DISTINCT required credentials. */
	function twoDistinctCredentialsService(): McpServiceDescriptor {
		return serviceFixture({
			serviceId: "named-headers",
			label: "Named Headers",
			authStrategy: "api_key",
			setup: {
				status: "requires-setup",
				reason: "paste your API key and application key",
				fields: [
					{ id: "SVC_API_KEY", label: "SVC_API_KEY", required: true, kind: "api-key" },
					{ id: "SVC_APPLICATION_KEY", label: "SVC_APPLICATION_KEY", required: true, kind: "api-key" },
				],
			},
		});
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "svc-catalog-token-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("identifies exactly the catalog's paste-an-api-key/token services — single-credential by construction", () => {
		const descriptors = defaultServiceCatalogProvider()();
		const pasteable = descriptors.filter((descriptor) => isPasteableTokenService(descriptor));
		// The 2026-09-16 single-credential cut: 11 one-paste services (the named-header pairs datadog and
		// cloudinary-mediaflows are cut from the catalog; the importer refuses to re-ship them).
		expect(pasteable.map((descriptor) => descriptor.serviceId).sort()).toEqual(
			[
				"aws-devops-agent",
				"github",
				"pagerduty",
				"sonatype-guide",
				"zoom",
				"zoom-canvas",
				"zoom-chat",
				"zoom-meetings",
				"zoom-revenue-accelerator",
				"zoom-tasks",
				"zoom-whiteboard",
			].sort(),
		);
		// GitHub's two fields are ALTERNATIVE NAMES for one PAT (a shared credentialSet): the paste flow collects ONE
		// credential, stored under the first alternative's id.
		const github = pasteable.find((descriptor) => descriptor.serviceId === "github");
		expect(github ? mcpCredentialFields(github).map((field) => field.id) : []).toEqual([
			"GITHUB_PAT_TOKEN",
			"GITHUB_PERSONAL_ACCESS_TOKEN",
		]);
		expect(github ? mcpPasteCredential(github) : undefined).toMatchObject({
			field: expect.objectContaining({ id: "GITHUB_PAT_TOKEN" }),
			fieldIds: ["GITHUB_PAT_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
		});
		// Non-token services are not pasteable.
		expect(isPasteableTokenService(serviceFixture())).toBe(false);
	});

	it("collapses alternative names to ONE credential; genuinely distinct credentials stay un-pasteable", () => {
		// A shared credentialSet across several fields = one credential.
		const alternatives = serviceFixture({
			serviceId: "alt-names",
			label: "Alt Names",
			authStrategy: "api_key",
			setup: {
				status: "requires-setup",
				fields: [
					{ id: "ALT_A", label: "ALT_A", required: true, kind: "bearer-token", credentialSet: "one-token" },
					{ id: "ALT_B", label: "ALT_B", required: true, kind: "bearer-token", credentialSet: "one-token" },
				],
			},
		});
		expect(mcpPasteCredential(alternatives)).toMatchObject({
			field: expect.objectContaining({ id: "ALT_A" }),
			fieldIds: ["ALT_A", "ALT_B"],
		});
		expect(isPasteableTokenService(alternatives)).toBe(true);
		// Two UNMARKED distinct credential fields = two credentials: the single
		// bearer runtime cannot represent them, so the flow fails closed.
		const distinct = twoDistinctCredentialsService();
		expect(mcpPasteCredential(distinct)).toBeUndefined();
		expect(isPasteableTokenService(distinct)).toBe(false);
		// The row stays honest setup_required with NO paste action — the
		// dead-end hint, not a multi-prompt that can never authenticate.
		const views = buildPluginViews({
			services: [distinct],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("setup_required");
		expect(views[0]?.pasteToken).toBeUndefined();
	});

	it("derives human prompt labels from the field, never the raw env var alone", () => {
		const descriptors = defaultServiceCatalogProvider()();
		const byId = (id: string) => descriptors.find((descriptor) => descriptor.serviceId === id);
		const github = byId("github");
		expect(github).toBeDefined();
		const githubCredential = github ? mcpPasteCredential(github) : undefined;
		expect(githubCredential).toBeDefined();
		expect(github && githubCredential ? mcpCredentialFieldPromptLabel(github, githubCredential.field) : "").toBe(
			"GitHub personal access token",
		);
		// Single-field services keep the plain noun (Kevin's live-testing example).
		expect(mcpCredentialFieldPromptLabel(byId("pagerduty")!, mcpCredentialFields(byId("pagerduty")!)[0]!)).toBe(
			"PagerDuty API key",
		);
		expect(mcpCredentialFieldPromptLabel(byId("zoom-chat")!, mcpCredentialFields(byId("zoom-chat")!)[0]!)).toBe(
			"Zoom Chat access token",
		);
		expect(
			mcpCredentialFieldPromptLabel(byId("sonatype-guide")!, mcpCredentialFields(byId("sonatype-guide")!)[0]!),
		).toBe("Sonatype Guide token");
	});

	it("shares ONE static-token usability rule: type, endpoint binding, non-empty bearer", () => {
		expect(mcpStaticTokenUsable(undefined, GITHUB_URL)).toMatchObject({ usable: false, reason: "missing" });
		expect(mcpStaticTokenUsable(oauthCredential(), GITHUB_URL)).toMatchObject({
			usable: false,
			reason: "wrong-type",
		});
		expect(mcpStaticTokenUsable(staticToken({ endpoint: undefined as never }), GITHUB_URL)).toMatchObject({
			usable: false,
			reason: "unbound",
		});
		expect(mcpStaticTokenUsable(staticToken({ endpoint: "https://other.example/mcp" }), GITHUB_URL)).toMatchObject({
			usable: false,
			reason: "cross-endpoint",
		});
		expect(mcpStaticTokenUsable(staticToken({ bearer: "" }), GITHUB_URL)).toMatchObject({
			usable: false,
			reason: "empty-bearer",
		});
		expect(mcpStaticTokenUsable(staticToken(), GITHUB_URL)).toEqual({ usable: true });
	});

	it("renders the token service as setup_required with a paste action, and env presence never connects it", () => {
		const github = defaultServiceCatalogProvider()().find((descriptor) => descriptor.serviceId === "github");
		expect(github).toBeDefined();
		const views = buildPluginViews({
			services: [github!],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]).toMatchObject({
			connectionStatus: "setup_required",
			connectable: false,
			pasteToken: true,
			connectionIds: [],
		});
		expect(views[0]?.setupHint).toBe(
			"paste a GitHub personal access token (GITHUB_PAT_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN)",
		);
	});

	it("never reports connected from a stored pasted token alone: pending until the handshake verifies", () => {
		const github = defaultServiceCatalogProvider()().find((descriptor) => descriptor.serviceId === "github");
		authStorage.set(mcpCredentialKey("github"), staticToken());
		const views = buildPluginViews({
			services: [github!],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]).toMatchObject({ connectionStatus: "pending", connectionIds: ["github"] });
	});

	it("surfaces an unbound pasted token as reconnect-required, never pending or connected", () => {
		const github = defaultServiceCatalogProvider()().find((descriptor) => descriptor.serviceId === "github");
		authStorage.set(mcpCredentialKey("github"), staticToken({ endpoint: "https://moved.example/mcp" }));
		const views = buildPluginViews({
			services: [github!],
			userServers: undefined,
			authStorage,
			connectionStore: store,
		});
		expect(views[0]?.connectionStatus).toBe("error");
		expect(views[0]?.setupHint).toContain("not bound to this endpoint");
	});

	it("verifies with the stored pasted token and records connected only after a real handshake", async () => {
		authStorage.set(mcpCredentialKey("github"), staticToken());
		const probedTokens: string[] = [];
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "github",
			serviceId: "github",
			label: "GitHub",
			endpoint: GITHUB_URL,
			usesOAuth: false,
			staticToken: true,
			probe: async (options) => {
				probedTokens.push(await options.getToken());
				return { ok: true, toolCount: 4 };
			},
		});
		expect(probedTokens).toEqual(["ghp_pasted-token"]);
		expect(record.status).toBe("connected");
		expect(record.toolCount).toBe(4);
		expect(store.get("github")).toMatchObject({ status: "connected", toolCount: 4 });
	});

	// The error-category invariant for pasted tokens is the SAME shared probe-error path pinned above ("records error
	// with a fixed safe category when the server rejects the credential").

	it("refuses to verify an unbound pasted token before any network operation", async () => {
		authStorage.set(mcpCredentialKey("github"), staticToken({ endpoint: "https://moved.example/mcp" }));
		const probe = vi.fn(async () => ({ ok: true as const, toolCount: 1 }));
		const record = await verifyMcpConnection({
			authStorage,
			connectionStore: store,
			connectionId: "github",
			serviceId: "github",
			label: "GitHub",
			endpoint: GITHUB_URL,
			usesOAuth: false,
			staticToken: true,
			probe,
		});
		expect(probe).not.toHaveBeenCalled();
		expect(record.status).toBe("error");
		expect(record.lastError).toBe(MCP_PROBE_ERRORS.UNBOUND_CREDENTIAL);
	});

	// The mid-probe rotation discard is the SAME queueVerifyResult guard pinned above ("discards a stale verify result
	// when the grant rotates mid-probe").

	it("keeps verification honest when no usable credential exists: never connected, never a probe", async () => {
		const probe = vi.fn(async () => ({ ok: true as const, toolCount: 1 }));
		const cases: Array<McpStaticTokenCredential | ReturnType<typeof oauthCredential> | undefined> = [
			undefined,
			oauthCredential(3600_000, GITHUB_URL),
			staticToken({ bearer: "" }),
		];
		for (const [index, credential] of cases.entries()) {
			if (credential) authStorage.set(mcpCredentialKey("github"), credential);
			else authStorage.remove(mcpCredentialKey("github"));
			// Each case gets a fresh record state: the verdict is per-case, and
			// a missing/wrong-typed/empty credential never inherits one.
			const caseStore = McpConnectionStore.open(join(tempDir, `conns-${index}`, "mcp-connections.json"));
			const record = await verifyMcpConnection({
				authStorage,
				connectionStore: caseStore,
				connectionId: "github",
				serviceId: "github",
				label: "GitHub",
				endpoint: GITHUB_URL,
				usesOAuth: false,
				staticToken: true,
				probe,
			});
			expect(record.status).toBe("pending");
			expect(record.lastError).toBe(MCP_PROBE_ERRORS.UNKNOWN);
			expect(record.verifiedAt).toBeUndefined();
			expect(record.toolCount).toBeUndefined();
		}
		expect(probe).not.toHaveBeenCalled();
	});
});
