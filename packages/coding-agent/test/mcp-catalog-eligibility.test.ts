// Authoritative ENG-6108 MCP catalog eligibility regressions, driven against the REAL generated catalog data and the
// ONE shared oauthGrantUsable predicate. The matrix asserts the SAME answer across every consumer that previously
// diverged: system-prompt eligibility (getEnabledPersistentGenericServers), kernel dispatch (mcp.config), and the
// picker/inventory view builders. The catalog cap section pins installed-row protection (still-in-source AND
// vanished-source), and the explicit >500-installed soft-discovery diagnostic. Offline only: in-memory or temp-file
// auth/records, no network, no provider calls; env vars are set and restored inside tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthCredential, AuthStorage, type McpStaticTokenCredential } from "../src/core/auth-storage.js";

import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import {
	buildPluginViews,
	defaultServiceCatalogProvider,
	type McpServiceDescriptor,
	oauthGrantUsable,
} from "../src/core/mcp/service-catalog.js";

const ENDPOINT = "https://matrix.example.test/mcp";

function descriptor(overrides: Partial<McpServiceDescriptor>): McpServiceDescriptor {
	return {
		serviceId: "matrix-service",
		label: "Matrix Service",
		aliases: [],
		transport: { type: "http", url: ENDPOINT },
		authStrategy: "none",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: false,
		...overrides,
	};
}

function _record(serviceId: string): McpConnectionRecord {
	const now = Date.now();
	return {
		connectionId: serviceId,
		serviceId,
		endpoint: ENDPOINT,
		label: `Matrix (${serviceId})`,
		status: "connected",
		createdAt: now,
		updatedAt: now,
	};
}

describe("MCP catalog eligibility (authoritative real-data regressions)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-eligibility-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const key of Object.keys(savedEnv)) delete savedEnv[key];
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function managerFor(options: {
		services?: readonly McpServiceDescriptor[];
		userServers?: Record<string, unknown>;
	}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => options.services ?? [],
			getUserServers: () => (options.userServers ?? undefined) as never,
		});
	}

	async function configFor(manager: McpManager, server: string): Promise<Record<string, unknown>> {
		const handler = manager.hostHandlers()["mcp.config"];
		if (!handler) throw new Error("mcp.config handler missing");
		return handler({ server });
	}

	function viewFor(
		services: readonly McpServiceDescriptor[],
		server: string,
	): ReturnType<typeof buildPluginViews>[number] | undefined {
		return buildPluginViews({
			services,
			userServers: undefined,
			authStorage,
			connectionStore: store,
		}).find((view) => view.serviceId === server);
	}

	it("sweeps the REAL catalog: no row is enabled without proven credentials, and the sweep is meaningful", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		// The sweep must actually cover the strategies Bugbot found divergent: real api_key rows and real unknown rows.
		// none+ready is asserted to be exactly zero TODAY so catalog drift forces a conscious update here. Post-2026-09-16
		// single-credential cut: 68 rows (57 one-click DCR, 11 one-paste user-setup), of which 10 are api_key strategy and
		// 53 unknown; the 2026-09-17 pinned-client decision added Slack as one-click row 69. The thresholds below stay
		// where they were — the cuts removed 6 api_key rows, 1 oauth row, and no unknown rows.
		expect(descriptors.length).toBeGreaterThan(50);
		expect(descriptors.filter((d) => d.authStrategy === "api_key").length).toBeGreaterThanOrEqual(10);
		expect(descriptors.filter((d) => d.authStrategy === "unknown").length).toBeGreaterThanOrEqual(50);
		expect(descriptors.filter((d) => d.authStrategy === "none").length).toBe(0);

		const manager = managerFor({ services: descriptors });
		const enabled = manager.getEnabledPersistentGenericServers();
		expect(enabled, "with empty credentials no real catalog row may be enabled").toEqual([]);
		expect(manager.listStatus().every((row) => !row.enabled)).toBe(true);

		// Setup-field env presence must NEVER be inferred as a credential —
		// even for the one real api_key row that NAMES its env var.
		const aws = descriptors.find((d) => d.serviceId === "aws-devops-agent");
		expect(aws?.authStrategy).toBe("api_key");
		savedEnv.DEVOPS_AGENT_TOKEN = process.env.DEVOPS_AGENT_TOKEN;
		process.env.DEVOPS_AGENT_TOKEN = "inferred-secret";
		try {
			const envManager = managerFor({ services: descriptors });
			expect(envManager.getEnabledPersistentGenericServers()).not.toContain("aws-devops-agent");
			expect(await configFor(envManager, "aws-devops-agent")).toEqual({});
			expect(envManager.listStatus().find((row) => row.server === "aws-devops-agent")?.enabled).toBe(false);
		} finally {
			if (savedEnv.DEVOPS_AGENT_TOKEN === undefined) delete process.env.DEVOPS_AGENT_TOKEN;
			else process.env.DEVOPS_AGENT_TOKEN = savedEnv.DEVOPS_AGENT_TOKEN;
			delete savedEnv.DEVOPS_AGENT_TOKEN;
		}
	});

	// The aws-devops-agent env-presence refusal is asserted inside the REAL catalog sweep above.

	it.each([
		["none+ready is credential-free eligible", descriptor({}), true],
		["none+requires-setup fails closed", descriptor({ setup: { status: "requires-setup" } }), false],
		["api_key requires-setup fails closed (env unset)", descriptor({ authStrategy: "api_key" }), false],
		["unknown without a credential fails closed", descriptor({ authStrategy: "unknown" }), false],
	])("%s across prompt and dispatch", async (_name, service, expectedEnabled) => {
		const manager = managerFor({ services: [service as McpServiceDescriptor] });
		const enabled = manager.getEnabledPersistentGenericServers();
		const configured = await configFor(manager, (service as McpServiceDescriptor).serviceId);
		if (expectedEnabled) {
			expect(enabled).toContain((service as McpServiceDescriptor).serviceId);
			expect(configured).not.toEqual({});
		} else {
			expect(enabled).not.toContain((service as McpServiceDescriptor).serviceId);
			expect(configured, "dispatch must not serve an unproven catalog row").toEqual({});
			const status = viewFor(
				[service as McpServiceDescriptor],
				(service as McpServiceDescriptor).serviceId,
			)?.connectionStatus;
			if ((service as McpServiceDescriptor).authStrategy === "unknown") {
				// OAuth-gated rows are RECONNECTABLE (not_connected + connect),
				// not setup_required — only api_key/requires-setup rows are.
				expect(status).toBe("not_connected");
			} else {
				expect(status).toBe("setup_required");
			}
		}
	});

	it("a none+requires-setup row never renders as connectable in the picker", () => {
		const service = descriptor({ setup: { status: "requires-setup" } });
		const view = viewFor([service], service.serviceId);
		expect(view?.connectionStatus).toBe("setup_required");
		expect(view?.connectable).toBe(false);
	});

	it("OAuth grant states agree across the shared predicate, prompt, dispatch, and the picker view", async () => {
		const service = descriptor({ authStrategy: "oauth" });
		const bound = {
			type: "oauth" as const,
			access: "valid-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			endpoint: ENDPOINT,
		};
		// The OAuthCredentials TYPE requires refresh: string; the shared predicate treats FALSY refresh as no-refresh
		// (Boolean(refresh), the status resolver's semantics), so "" is the type-clean fixture.
		const cases: ReadonlyArray<{
			name: string;
			credential: AuthCredential;
			enabled: boolean;
			reason: string | undefined;
		}> = [
			{ name: "valid bound grant", credential: bound, enabled: true, reason: undefined },
			{
				name: "expired grant WITH refresh stays usable (dispatch refreshes)",
				credential: { ...bound, access: "stale", expires: Date.now() - 1000 },
				enabled: true,
				reason: undefined,
			},
			{
				name: "expired grant WITHOUT refresh fails closed",
				credential: { ...bound, access: "stale", refresh: "", expires: Date.now() - 1000 },
				enabled: false,
				reason: "expired-no-refresh",
			},
			{
				// Intentionally wrong-typed so the guard is exercised on the TYPE, with an endpoint that MATCHES — the old
				// endpoint-only check passed exactly this shape, so this is the authoritative wrong-type regression.
				name: "wrong-type credential fails closed",
				credential: {
					type: "api_key",
					key: "not-oauth",
					endpoint: ENDPOINT,
				} as unknown as AuthCredential,
				enabled: false,
				reason: "wrong-type",
			},
			{
				name: "empty-access credential fails closed",
				credential: { ...bound, access: "" },
				enabled: false,
				reason: "empty-access",
			},
			{
				name: "unbound credential fails closed",
				credential: { ...bound, endpoint: undefined },
				enabled: false,
				reason: "unbound",
			},
			{
				name: "cross-endpoint credential fails closed",
				credential: { ...bound, endpoint: "https://other.example.test/mcp" },
				enabled: false,
				reason: "cross-endpoint",
			},
		];
		for (const testCase of cases) {
			authStorage.set(`mcp:${service.serviceId}`, testCase.credential);
			const usable = oauthGrantUsable(authStorage.get(`mcp:${service.serviceId}`), ENDPOINT);
			expect(usable.reason, `${testCase.name}: shared predicate reason`).toBe(testCase.reason);
			const manager = managerFor({ services: [service] });
			const enabled = manager.getEnabledPersistentGenericServers();
			const configured = await configFor(manager, service.serviceId);
			const view = viewFor([service], service.serviceId);
			if (testCase.enabled) {
				expect(enabled, testCase.name).toContain(service.serviceId);
				expect(configured, testCase.name).not.toEqual({});
			} else {
				expect(enabled, testCase.name).not.toContain(service.serviceId);
				expect(configured, testCase.name).toEqual({});
				if (usable.reason === "expired-no-refresh") {
					expect(view?.setupHint, testCase.name).toContain("expired without a refresh token");
				}
				if (usable.reason === "unbound" || usable.reason === "cross-endpoint") {
					expect(view?.setupHint, testCase.name).toContain("not bound to this endpoint");
				}
			}
		}
	});

	it("user-declared servers keep their semantics, but a configured bearer env var is the ONLY credential source", async () => {
		// Anonymous HTTP: the user owns the auth decision; stays enabled.
		let manager = managerFor({
			services: [],
			userServers: { anonymous: { type: "http", url: "https://anon.example.test/mcp" } },
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("anonymous");
		expect(await configFor(manager, "anonymous")).not.toEqual({});

		// stdio: unchanged.
		manager = managerFor({
			services: [],
			userServers: { local: { type: "stdio", command: "run-me" } },
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("local");

		// disabled: excluded everywhere.
		manager = managerFor({
			services: [],
			userServers: { off: { type: "stdio", command: "no", enabled: false } },
		});
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("off");

		// Bearer env UNSET: must fail closed even though a stale OAuth grant for the same id is bound to the same endpoint
		// (the old stale-OAuth fall-through Bugbot flagged).
		authStorage.set("mcp:bearer", {
			type: "oauth" as const,
			access: "stale-oauth-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://bearer.example.test/mcp",
		});
		manager = managerFor({
			services: [],
			userServers: {
				bearer: { type: "http", url: "https://bearer.example.test/mcp", bearerTokenEnvVar: "MATRIX_BEARER" },
			},
		});
		expect(
			manager.getEnabledPersistentGenericServers(),
			"unset bearer env must fail closed with no stale-OAuth fallback",
		).not.toContain("bearer");
		// A user-declared config is the user's own: mcp.config serves it and the kernel fails late at connection time. The
		// stale-OAuth regression is the eligibility exclusion above, which must hold even with a bound grant stored under
		// the same id.
		expect((await configFor(manager, "bearer")).bearerTokenEnvVar).toBe("MATRIX_BEARER");

		// Bearer env SET: enabled and served.
		savedEnv.MATRIX_BEARER = process.env.MATRIX_BEARER;
		process.env.MATRIX_BEARER = "configured-bearer";
		manager = managerFor({
			services: [],
			userServers: {
				bearer: { type: "http", url: "https://bearer.example.test/mcp", bearerTokenEnvVar: "MATRIX_BEARER" },
			},
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("bearer");
		expect(await configFor(manager, "bearer")).not.toEqual({});
	});
});

describe("MCP catalog token services (paste flow) eligibility and dispatch", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	const savedEnv: Record<string, string | undefined> = {};
	const GITHUB_URL = "https://api.githubcopilot.com/mcp/";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-token-eligibility-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const key of Object.keys(savedEnv)) delete savedEnv[key];
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function managerFor(options: {
		services?: readonly McpServiceDescriptor[];
		userServers?: Record<string, unknown>;
	}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => options.services ?? [],
			getUserServers: () => (options.userServers ?? undefined) as never,
		});
	}

	async function configFor(manager: McpManager, server: string): Promise<Record<string, unknown>> {
		const handler = manager.hostHandlers()["mcp.config"];
		if (!handler) throw new Error("mcp.config handler missing");
		return handler({ server });
	}

	function storedGithubToken(overrides: Partial<McpStaticTokenCredential> = {}): McpStaticTokenCredential {
		return {
			type: "mcp_static_token",
			endpoint: GITHUB_URL,
			bearer: "ghp_pasted-token",
			bearerFieldId: "GITHUB_PAT_TOKEN",
			createdAt: Date.now(),
			...overrides,
		};
	}

	it("a stored pasted token enables the real github row with the setup env var UNSET", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		// The setup fields NAME env vars; they stay UNSET and unread.
		savedEnv.GITHUB_PAT_TOKEN = process.env.GITHUB_PAT_TOKEN;
		delete process.env.GITHUB_PAT_TOKEN;
		savedEnv.GITHUB_PERSONAL_ACCESS_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

		authStorage.set("mcp:github", storedGithubToken());
		const manager = managerFor({ services: descriptors });
		expect(manager.getEnabledPersistentGenericServers()).toContain("github");
		expect(manager.listStatus().find((row) => row.server === "github")?.enabled).toBe(true);
		const config = await configFor(manager, "github");
		expect(config).toMatchObject({
			type: "http",
			url: GITHUB_URL,
			credentialSource: "static-token",
		});
	});

	it("a stored pasted token enables nothing else: eligibility binds to the exact id and endpoint", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		authStorage.set("mcp:github", storedGithubToken());
		const manager = managerFor({ services: descriptors });
		const enabled = manager.getEnabledPersistentGenericServers();
		expect(enabled).toContain("github");
		// Every other token service stays closed (its id has no credential).
		for (const serviceId of ["pagerduty", "sonatype-guide", "zoom"]) {
			expect(enabled, serviceId).not.toContain(serviceId);
		}
		// A token bound to another endpoint never serves this row.
		authStorage.set("mcp:pagerduty", storedGithubToken());
		const other = managerFor({ services: descriptors });
		expect(other.getEnabledPersistentGenericServers()).not.toContain("pagerduty");
		expect(await configFor(other, "pagerduty")).toEqual({});
	});

	it("github still fails closed with no stored token even when its setup env vars are set", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		savedEnv.GITHUB_PAT_TOKEN = process.env.GITHUB_PAT_TOKEN;
		process.env.GITHUB_PAT_TOKEN = "ambient-guess";
		const manager = managerFor({ services: descriptors });
		// No inference from field ids: the env var the field NAMES is not a source.
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("github");
		expect(await configFor(manager, "github")).toEqual({});
	});

	it("a wrong-typed or unbound stored credential never enables a token service", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		// An OAuth grant stored under the token service id is the wrong type.
		authStorage.set("mcp:github", {
			type: "oauth",
			access: "oauth-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: GITHUB_URL,
		});
		let manager = managerFor({ services: descriptors });
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("github");
		expect(await configFor(manager, "github")).toEqual({});

		// An unbound pasted token (no endpoint) fails closed too.
		authStorage.set("mcp:github", storedGithubToken({ endpoint: undefined as never }));
		manager = managerFor({ services: descriptors });
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("github");
		expect(await configFor(manager, "github")).toEqual({});
	});

	it("a reserved builtin name with a stored pasted token still fails closed under a user shadow", async () => {
		const reservedTokenService = descriptor({
			serviceId: "linear",
			label: "Linear",
			legacyBuiltin: true,
			authStrategy: "api_key",
			setup: {
				status: "requires-setup",
				reason: "paste a token",
				fields: [{ id: "LINEAR_TOKEN", label: "LINEAR_TOKEN", required: true, kind: "bearer-token" }],
			},
		});
		authStorage.set("mcp:linear", {
			type: "mcp_static_token",
			endpoint: "https://shadow.example.test/mcp",
			bearer: "shadow-token",
			bearerFieldId: "LINEAR_TOKEN",
			createdAt: Date.now(),
		});
		const manager = managerFor({
			services: [reservedTokenService],
			userServers: { linear: { type: "http", url: "https://shadow.example.test/mcp", oauth: true } },
		});
		expect(
			manager.getEnabledPersistentGenericServers(),
			"a shadowed reserved name never dispatches, even with a stored token",
		).not.toContain("linear");
		expect(await configFor(manager, "linear")).toEqual({});
	});
});
